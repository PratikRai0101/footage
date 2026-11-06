# Sealed protocol differential tests

This offline runner compiles the production Swift source with Swift 6 and CryptoKit, then exchanges binary records with the production Node codec. It does not build Expo, open network listeners, or activate upload routes.

## Commands

From the repository root, with the existing npm dependencies and Apple's Swift toolchain installed:

```sh
npx --no-install tsx --test apps/server/test/sealed-protocol.test.ts
npx --no-install tsc -p scripts/test/sealed-protocol/tsconfig.json
npx --no-install tsx scripts/test/sealed-protocol/run.ts
```

## Generated vectors

`run.ts` creates four private manifests covering standalone and T3 destinations, NFC text, DNS A-labels, IPv4, and IPv6. Node and Swift independently encode the manifest, destination, header, AAD, HKDF keys, AES-GCM packet, setup reply, query, acknowledgment, receipt, ingest envelope, and nine status records per manifest. The runner compares every output byte. Each implementation also opens the other implementation's production-random sealed packet.

`fixtures.ts` and `Harness.swift` contain test-only deterministic AEAD invocations. Their fixed nonces and seal IDs never enter the production module. Masters, UUIDs, and receiver identities are fresh synthetic values on every run. No key fixtures or vector output files are committed. The runner creates a private temporary directory, restricts the JSON files to mode 0600, prints no vector bytes, and removes the directory in `finally`.

Both suites reject malformed records, forged outcomes, incorrect binding, invalid partitioning, stale challenges and revisions, and late-frame failures. Each suite processes an eight-frame group through bounded read and quarantine interfaces and checks the exact 64 MiB + 544 wire length. The 4 GiB partition test constructs only its manifest, not a 4 GiB original.

The no-op intent-persistence callbacks and in-memory quarantines are test adapters. They are not durable storage implementations or evidence for G3 or G4. See `docs/evidence/sealed-protocol-codecs.md` for the scope and integration requirements.
