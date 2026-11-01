# Deploying the runner on Cloud Run

This is a recipe, not a script: nothing here has been run by the plugin's tests, and the plugin never
calls `gcloud`. Every flag marked **(verify)** is written from memory of the gcloud surface; check it
against `gcloud run deploy --help` and the current Cloud Run docs before you rely on it. If a flag
does not exist in your gcloud version, the guarantee it was there for is NOT in place, whatever
the rest of the command does.

It implements the remote-backend checklist of loom ADR 0144 D6:

| D6 item | Where it comes from |
|---|---|
| no service account or credentials | a dedicated service account with no roles; nothing mounted (step 2, 4) |
| egress denied at the network layer | Direct VPC egress of all traffic into a subnet with no NAT and a deny-all egress firewall (step 1, 4) |
| one request per instance | `--concurrency 1` plus `EXIT_AFTER_EACH_REQUEST=1` (step 4) |
| the request timeout is the hard kill | the runner kills the child at `wallClockMs`; `--timeout` backstops it (step 4) |
| memory and CPU caps | `--memory` / `--cpu` on the instance, `RLIMIT_AS` / `RLIMIT_CPU` on the child (step 4) |
| no shared writable state | no volume mounts; the container's writable filesystem is in-memory and per instance (verify) (step 4) |

Variables used below:

```sh
PROJECT=my-project          REGION=europe-west1        SERVICE=loom-sandbox
REPO=loom-sandbox           IMAGE=$REGION-docker.pkg.dev/$PROJECT/$REPO/runner:1
```

## 1. Network with no way out

A custom VPC whose subnet has **no Cloud NAT and no external route use**, and a firewall rule that
denies all egress. Cloud Run sends all of the service's traffic through it with Direct VPC egress.

```sh
gcloud compute networks create sandbox-net --subnet-mode=custom --project=$PROJECT
gcloud compute networks subnets create sandbox-subnet \
  --network=sandbox-net --region=$REGION --range=10.99.0.0/24 --project=$PROJECT
# Private Google Access stays OFF (the default): it would let the sandbox reach Google APIs.

gcloud compute firewall-rules create sandbox-deny-all-egress \
  --network=sandbox-net --direction=EGRESS --action=DENY --rules=all \
  --destination-ranges=0.0.0.0/0 --priority=100 --project=$PROJECT
```

Do not create a Cloud NAT or a Cloud Router for this network. Do not add an allow rule above
priority 100. (Verify the firewall flag spellings; they are long-standing `gcloud compute` flags but
this recipe was not run.)

## 2. A service account with no roles

```sh
gcloud iam service-accounts create sandbox-runner --project=$PROJECT
# Grant it NOTHING. No `add-iam-policy-binding` for this account, ever.
```

The metadata server stays reachable from a Cloud Run container whatever the VPC rules say (**verify**
in your project), so a script can obtain this account's token. A token for an account that holds no
roles cannot do anything; that is the whole defence, and it is why this step is not optional. Do not
reuse the default compute service account, which commonly holds Editor.

## 3. Build the image

```sh
gcloud artifacts repositories create $REPO --repository-format=docker \
  --location=$REGION --project=$PROJECT
gcloud builds submit runner/ --tag=$IMAGE --project=$PROJECT       # (verify) build context = runner/
```

The image is `python:3.12-slim` plus one file. Nothing is `pip install`ed. The runner needs Python 3.9
or newer.

## 4. Deploy

```sh
gcloud run deploy $SERVICE \
  --image=$IMAGE \
  --region=$REGION --project=$PROJECT \
  --execution-environment=gen2 \
  --no-allow-unauthenticated \
  --service-account=sandbox-runner@$PROJECT.iam.gserviceaccount.com \
  --network=sandbox-net --subnet=sandbox-subnet --vpc-egress=all-traffic \
  --concurrency=1 \
  --max-instances=10 \
  --memory=512Mi --cpu=1 \
  --timeout=75s \
  --set-env-vars=EXIT_AFTER_EACH_REQUEST=1,MAX_WALL_CLOCK_MS=60000
```

Flags to verify against current docs: **(verify)** `--execution-environment=gen2` (**this is the one to read carefully**: the ADR's
checklist asks for a gVisor-class boundary, and gen2 was specified as such here, but my recollection
is that Cloud Run's docs describe gen1 as the gVisor-based sandbox and gen2 as a microVM with a fuller
Linux kernel, and that Direct VPC egress requires gen2. Confirm which environment gives which isolation
and what your threat model needs; if you need gVisor, check that it is compatible with the VPC egress
setup you chose, because the egress guarantee below is separate from it), **(verify)** `--network`, `--subnet` and `--vpc-egress=all-traffic` (Direct VPC egress; older
guidance used a Serverless VPC Access connector with `--vpc-connector`, which this recipe does not
use), **(verify)** `--no-allow-unauthenticated`, `--concurrency`, `--max-instances`, `--memory`,
`--cpu`, `--timeout` (seconds; the `s` suffix form is **(verify)**), `--set-env-vars`.

Why these values:

- **`--concurrency=1` and `EXIT_AFTER_EACH_REQUEST=1`** are what make `freshInstancePerRun` true. The
  runner answers one request and exits; Cloud Run starts a new instance, with a new in-memory
  filesystem, for the next. Either alone is not enough: with concurrency above 1 two scripts share
  an instance, and without the exit `/tmp` and anything else the child left outside its own
  directory survive to the next request, which may be another tenant's. The cost is a cold start
  per run. Without `EXIT_AFTER_EACH_REQUEST` the service still works and is cheaper, and you declare
  `freshInstancePerRun: false`.
- **`--timeout`** must be at least the largest `wallClockMs` you will request, plus the grace for
  boot and the kill. The runner kills the child itself at `wallClockMs` (clamped to
  `MAX_WALL_CLOCK_MS`), so the platform timeout is the backstop. loom's `SandboxEffect` additionally
  races the call against `wallClockMs + backendGraceMs` (default 60 s), so raise `backendGraceMs`
  if cold starts are slower than that.
- **`--memory`** must exceed the largest `memoryBytes` you will request plus the interpreter and
  the runner (`MEMORY_OVERHEAD_BYTES`, 96 MiB by default). `memoryBytes` is enforced on the child by
  `RLIMIT_AS`; the instance limit is the second line.
- **No `--set-secrets`, no `--add-volume`, no extra env vars** beyond the two above. Do not put
  anything in this service's environment that you would mind a model-written script reading: the child
  starts with an empty environment, but it runs as the same user in the same container.
- **`--max-instances`** bounds the cost of a flood.
- `--ingress=internal` (**verify**) additionally keeps the service off the public internet if your
  callers are inside the VPC. Authentication below is required either way.

## 5. Authenticate the caller

The service requires an ID token whose audience is the service URL. From a machine or workload with
`roles/run.invoker` on this service:

```sh
gcloud run services add-iam-policy-binding $SERVICE --region=$REGION --project=$PROJECT \
  --member=serviceAccount:<the caller's service account> --role=roles/run.invoker   # (verify)
```

Inside Google Cloud, the metadata server issues the token (no library needed):

```sh
curl -s -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=$URL"
```

In Node, the same call is one `fetch` with that header and the `identity?audience=` URL; wrap it
in `getAuthHeaders`, cache the token until shortly before it expires (about an hour), and refresh on
demand. From a workstation: `gcloud auth print-identity-token --audiences=$URL` **(verify; audience
support differs by account type)**.

## 6. Earn the capabilities

The client cannot see how the service is deployed, so `CloudRunSandboxBackend` defaults to the
weakest claims (`egress: "open"`, `freshInstancePerRun: false`). A stronger claim is true only if
the conformance kit passes against the DEPLOYED url with that claim, because the kit then runs the
cases the claim unlocks.

```sh
URL=$(gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT --format='value(status.url)')   # (verify)
export LOOM_CLOUDRUN_SANDBOX_URL=$URL
export LOOM_CLOUDRUN_SANDBOX_TOKEN=$(gcloud auth print-identity-token --audiences=$URL)    # (verify)
export LOOM_CLOUDRUN_SANDBOX_EGRESS=blocked      # claim network: "none"
export LOOM_CLOUDRUN_SANDBOX_FRESH=1             # claim freshPerRun
pnpm --filter loom-plugin-cloudrun-sandbox exec vitest run src/live.test.ts
```

- With `EGRESS=blocked` the kit runs the no-network/no-escape case: the Python probes attempt TCP
  connections to public addresses and fail the claim if any connects.
- With `FRESH=1` it runs the fresh-per-run case: 16 sequential runs and a batch of 8 concurrent
  ones, each of which must see an empty `/tmp`. A reused instance fails on the second run.
- Each run costs a cold start when `EXIT_AFTER_EACH_REQUEST=1`, so the live test raises its timeout to
  300 s per case. The token above lasts about an hour; refresh it for a long run.
- Keep the claim in your code identical to the claim you tested, and rerun the kit whenever the
  network, the service account, the image or the flags change. Re-running is the only evidence;
  a deploy script is not.

The live test is skipped when `LOOM_CLOUDRUN_SANDBOX_URL` is unset. It talks to a real service, so the
plugin's own CI never runs it.
