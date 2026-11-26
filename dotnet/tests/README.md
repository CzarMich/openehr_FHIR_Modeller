# Contract probes

Run `run-contracts.py --dll <published-or-built-dll>` on a .NET 10 development
machine, `--image <hosted-built-image>` for runtime packaging, or `--sdk-image
<pinned-sdk-image>` on Dev after compiling in that SDK container. The SDK option
uses the existing `bin/Release/net10.0` output; it does not build an image on Dev.

The runner creates an isolated guide copy, a private canary symlink, random scoped
credentials and a loopback-only endpoint. It cleans up its own server/fixtures.
The independent client tests both HTTP and stdio and emits concise JSON evidence.
