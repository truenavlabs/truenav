# TEST ONLY source registry

`source-registry.TEST.json` contains public verification keys only. It is simulated test evidence, never a production trust root. Test signing keys are generated at runtime from the explicitly public TEST seed label in the Rust tests. No private key is serialized or committed.

The key IDs, roles, fund scopes and validity windows match `verifier/fixtures/source-registry.json` at a17b1c3. Its repeated-byte public key placeholders are replaced here by usable TEST verification keys. Those public key bytes differ. The verifier lane must explicitly select this registry when rechecking the derived engine TEST vectors. Its files are unchanged by this lane.
