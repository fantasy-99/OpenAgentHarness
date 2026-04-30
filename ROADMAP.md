# OAH Control Plane And Worker Roadmap

## 1. Current Architecture

OAH now treats the split deployment as the production baseline:

- `oah-api` is the ingress and control-plane facade.
- `oah-controller` owns fleet, placement, lifecycle, and scale decisions.
- `oah-sandbox` hosts standalone workers and active workspace copies.
- PostgreSQL, Redis, and object storage are shared infrastructure, not worker-local truth.

The core routing boundary is still:

- `workspace -> owner worker`

The core data boundary is:

- active mutable workspace state lives on the owner worker while the workspace is active
- durable idle state is flushed to object storage
- API reads metadata and routes requests, but should not materialize, tar, sync, or recursively walk workspace contents in normal split mode

## 2. Responsibility Split

### API Server

`oah-api` should stay lightweight and mostly stateless:

- accept external HTTP / SSE requests
- resolve caller context and authorization
- validate request shape
- read/write metadata through repositories
- look up workspace ownership, placement, and routing hints
- proxy workspace file, sandbox, creation, deletion, and execution requests to the owner worker when a worker should own the operation
- expose control-plane views that are bounded, paged, and safe for production

`oah-api` should avoid:

- reading large workspace files into JavaScript heap
- building or extracting workspace archives
- walking entire workspace trees
- listing huge object-storage prefixes into memory
- owning writable active workspace copies in split deployment
- doing object-storage seed / flush / delete work when a worker can own it

### Worker / Sandbox

`oah-sandbox` and the worker process should own heavy workspace behavior:

- runtime initialization
- workspace materialization
- active file read/write
- command and tool execution
- object-storage hydrate / flush
- workspace backing-store cleanup
- tar / bundle creation and extraction
- drain, eviction, and local cache cleanup
- lease and placement publication

This matches the deployment model: workers are horizontally scalable, restartable, and closer to the CPU, disk, and network work that workspace operations need.

### Controller

`oah-controller` should continue moving toward active fleet governance:

- observe Redis queue pressure and worker health
- observe workspace placement state
- assign target workers for unassigned or stale placements
- respect owner affinity without treating ownerId as ownership truth
- avoid scale-down while placements are unstable
- scale `oah-sandbox` capacity from observed demand and pressure
- coordinate drain and recovery behavior

## 3. Recently Completed Baseline

The older roadmap phases around naming, controller topology, placement registry, sandbox host contracts, and E2B-compatible host adapters are implemented at the contract level and are no longer tracked here as open roadmap work.

Current implemented baseline:

- `controller` is the primary control-plane name in packages, manifests, chart values, and docs.
- Redis workspace placement state exists separately from transient ownership leases.
- Workers publish placement and ownership data.
- API routes can proxy workspace and sandbox requests to owner workers.
- Self-hosted sandbox routing can use worker / placement data.
- Sandbox host abstraction exists for embedded, self-hosted, and E2B-compatible providers.
- Split deployment docs and examples already model `oah-api + oah-controller + oah-sandbox`.
- Local split deployment no longer mounts a persistent workspace volume into `oah-api`.
- Object-storage sync has streaming upload/download paths for S3 and store-native prefix deletion where supported.

## 4. Open Roadmap

### A. Thin API Enforcement

Status: in progress

Goal: make the API process a control plane only in split deployments.

Done:

- Self-hosted API-only workspace creation delegates to the worker through `/internal/v1/sandboxes`.
- API-only delegation waits briefly for the worker-created workspace record to become visible.
- Workspace ownership resolution falls back from live leases to placement state when placement still has a valid owner worker URL.
- Explicit `externalRef` is preserved during legacy local initialization.

Remaining:

1. Move workspace deletion backing-store cleanup fully to workers when `sandbox.provider=self_hosted`.
2. Keep API deletion as metadata/routing only, except for local embedded modes.
3. Add a worker-side delete protocol that can clean active copies, object-storage prefixes, and local cache in one owner-scoped operation.
4. Make deletion routing use placement/ownerBaseUrl even when a transient lease has expired.
5. Add tests proving API deletion does not call object-storage deletion directly in self-hosted split mode.
6. Review workspace import paths and either delegate them to workers or clearly mark them local/admin-only.
7. Ensure public file upload/download routes stream through proxy paths and do not require large API-resident buffers in split mode.

### B. Worker-Owned Workspace Lifecycle

Status: in progress

Goal: workspace lifecycle work should happen where the active copy lives.

Remaining:

1. Define a single worker-owned workspace lifecycle API:
   - create
   - hydrate
   - flush
   - delete
   - evict
   - repair placement
2. Make worker lifecycle operations idempotent so retries after API/controller failure are safe.
3. Persist enough operation state to resume after worker restart.
4. Add explicit behavior for ownerless workspaces and warm shared workers.
5. Publish lifecycle metrics:
   - hydrate duration
   - flush duration
   - deleted bytes / object count
   - evicted cache bytes
   - failed lifecycle operations

### C. Object Storage Scalability

Status: in progress

Done:

- S3 `getObjectToFile` streams downloads to disk.
- S3 `putObjectFromFile` streams uploads from disk.
- Bundle write/hydrate paths use file-based store methods where available.
- S3 prefix delete uses paged native deletion instead of a resident full key list.
- TypeScript sync fallback uses file-based upload/download when the store supports it.

Remaining:

1. Add paged object listing APIs so diff planning does not require full-prefix resident arrays.
2. Add multipart upload for large files and large bundles.
3. Stream tar creation/extraction directly where practical instead of staging large bundles then uploading.
4. Shard sync manifests for very large workspaces.
5. Add byte, object-count, retry, and timeout limits per sync operation.
6. Expose object-store metrics:
   - list pages
   - bytes uploaded/downloaded
   - object count
   - retry count
   - throttling / timeout count

### D. Sandbox Fleet Control

Status: in progress

Goal: the controller should manage real sandbox capacity, not just report logical demand.

Done:

- `sandbox.fleet.*` config exists for remote sandbox capacity hints.
- Controller snapshots expose logical sandbox demand.
- Placement hints can influence queue routing through `preferredWorkerId`.

Remaining:

1. Add a real sandbox inventory or registry for observed active sandbox pods.
2. Attach `sandboxFleet.desiredSandboxes` to concrete self-hosted scaling actions.
3. Feed worker disk, memory, CPU, and active workspace pressure into placement and scale decisions.
4. Add warm-empty sandbox management.
5. Add an E2B-native lifecycle control path behind the same host contract.

### E. Storage Admin And Metadata Scale

Status: in progress

Done:

- Redis overview uses bounded scanning for queue, lock, and event keys.
- Redis overview exposes truncation signals.

Remaining:

1. Make broad Postgres counts optional, cached, or approximate.
2. Require explicit opt-in for expensive full-row text search.
3. Prefer keyset pagination for deep table browsing.
4. Move large archive payloads out of Postgres rows and into object storage or exported bundles.
5. Stream archive construction instead of building one large in-memory archive object.
6. Add retention policies for history events, session events, runs, and exported archives.

### F. Production Storage And SLOs

Status: pending

Remaining:

1. Make object storage a first-class production requirement in Helm examples and production docs.
2. Require explicit worker workspace cache sizing through PVC or ephemeral-storage guidance.
3. Add per-worker disk watermarks and readiness signals.
4. Add workspace policy hooks for maximum active copy size, object count, and single-file size.
5. Add alerts for:
   - worker disk pressure
   - materialization latency
   - object-store sync failure rate
   - drain flush duration
   - Redis queue depth and memory
   - Postgres table/index bloat
6. Add backup and restore runbooks for Postgres, Redis queue state, object storage prefixes, and archive exports.

## 5. Code Areas To Audit Next

These are the next places to inspect when continuing the API-thinning work:

- `apps/server/src/bootstrap.ts`
  - workspace deletion handler
  - initializer selection
  - ownership and placement fallback
- `apps/server/src/http/routes/workspaces.ts`
  - public workspace deletion
  - file upload/download body handling
  - owner proxy behavior
- `apps/server/src/http/routes/internal-workspaces.ts`
  - worker-side delete semantics
  - internal lifecycle endpoints
- `apps/server/src/http/routes/internal-sandboxes.ts`
  - worker-side create/import behavior
  - idempotency for create with explicit workspaceId
- `apps/server/src/object-storage.ts`
  - paged list/diff planning
  - multipart and streaming bundle paths
- `apps/server/src/bootstrap/workspace-materialization.ts`
  - drain/flush/delete lifecycle ownership
  - operation recovery after worker restart
- `apps/server/src/bootstrap/control-plane-runtime.ts`
  - stale placement reconciliation
  - metadata-only workspace visibility
- `apps/controller/src`
  - concrete sandbox scale target integration
  - placement action execution policy

## 6. Non-Goals

- replacing `worker` with `sandbox` as the primary runtime role
- moving ownership truth from workspace to user
- introducing multi-writer live workspace sync between pods
- removing embedded worker mode
- making E2B resource semantics the core OAH architecture
- forcing a breaking config migration before split mode is stable
- using `oah-api` as a large-file or workspace-sync worker in production split mode
