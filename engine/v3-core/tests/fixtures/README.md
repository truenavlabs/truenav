# TEST ONLY source registry

Fixture keys are publicly derivable test keys for reproducibility. The live demo uses fresh runtime keys.

`source-registry.TEST.json` is a byte-identical public-only snapshot of an internal simulated-data fixture registry (`sim/fixtures/source-key-registry.json`, not in this repository). Tests derive their in-memory TEST signing material using its public seed and length-prefixed truenav-sim-key-v1 framing. No private key is serialized or committed.

This supersedes an earlier TEST registry. An older verifier fixture has different IDs and placeholder public keys. A verifier must select this same registry, not combine the two registries. Live keys require distinct IDs such as servicer:live_<run-id>:v1, preserving the frozen source-key schema. Fixture and live registries never share a verification context. A loaded key ID cannot be rebound to different public-key bytes.

The simulated-data generator's current liveRoleKeys helper still reuses fixture IDs. The live host deliberately rejects that registry until distinct live IDs are assigned. No live generation or key swap is performed here.
