# TEST ONLY source registry

Fixture keys are publicly derivable test keys for reproducibility. The live demo uses fresh runtime keys.

`source-registry.TEST.json` is a byte-identical public-only snapshot of `sim/fixtures/source-key-registry.json` on lab/sim-data at e6f45ebf3b230e35d6bd1b9aa25b7b70f897b8c9. No sim/ files are edited. Tests derive their in-memory TEST signing material using that lane's public seed and length-prefixed truenav-sim-key-v1 framing. No private key is serialized or committed.

This supersedes the earlier backend-only TEST registry. The old lab/verifier a17b1c3 fixture has different IDs and placeholder public keys. Its files remain untouched. The verifier lane must select this same sim registry, not combine the two registries. Live keys require distinct IDs such as servicer:live_<run-id>:v1, preserving the frozen source-key schema. Fixture and live registries never share a verification context. A loaded key ID cannot be rebound to different public-key bytes.

The sim lane's current liveRoleKeys helper at the pinned commit still reuses fixture IDs. The backend live host deliberately rejects that registry until the owning lane assigns the distinct live IDs. No live generation or key swap is performed here.
