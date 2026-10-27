# Engine process launch

`index.ts` prepares the verified Engine child's environment. Rust parser workers
receive a minimum 32 MiB stack reserve; larger explicit reserves remain intact.
This prevents the reproduced daemon abort on long Rust expression trees. It does
not change the parent environment, enablement, policy, or provider settings.
Windows keeps its private Engine state directory and local endpoint mapping.

The native regression analyzes a real synthetic Rust checkout through
`EngineSupervisor` and confirms Graph data plus a subsequent control ping.
Environment tests cover disablement, invalid and larger reserves, parent
immutability and Windows state placement. Set `GRANTTAP_ENGINE_TEST_BINARY` to
an exact verified native binary to run the native case.

This is a fixed worker reserve, not a guarantee against arbitrary resource
exhaustion. [Engine bridge](../../README.md) owns the public runtime boundary.

License: GrantTap Commercial Source License; see the repository-root `LICENSE`.
