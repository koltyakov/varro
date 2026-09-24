# Stateless helper generation

Title fallback and commit-message generation first check the connected v2 server's
OpenAPI document for `/api/experimental/generate`. When available, Varro sends one
prompt with the selected provider, model, and variant, and validates the returned
JSON before applying it. This operation does not create a session.

The existing helper-session path remains available on v1, when the operation is
absent, and when the v2 base runner rejects the exact selected model as unavailable
before contacting its provider. The isolated v2.0.15 fixture demonstrated this
rejection for a configured custom provider, including one in global configuration.
The fallback made exactly one provider request and cleaned up its helper session.

Provider errors, authentication failures, timeouts, malformed responses, and
cancellation do not trigger a second generation. Commit messages retain their
existing source fingerprint and draft checks. A generated title still applies
only if the destination session has its placeholder title.

The stateless success path is covered by mocked service and transport tests.
Successful stateless generation against a real provider remains unverified. The
released-server fixture verifies admission rejection and the helper-session path.

Run the focused contract checks with:

```sh
npm run test -- src/extension/one-shot-generation.test.ts src/extension/session-title-fallback.test.ts src/extension/commit-message-service.test.ts src/extension/opencode-v2.test.ts
VARRO_OPENCODE_TEST_BINARY=/path/to/opencode npm run test -- src/extension/opencode-v2.integration.test.ts
```
