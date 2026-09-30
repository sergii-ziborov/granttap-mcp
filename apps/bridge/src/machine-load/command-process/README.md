# Command process measurements

`history.ts` owns bounded operating-system samples for command calls. It matches
hashed command fingerprints and process ancestry to an observed provider tool
call, then derives CPU time and sampled peak RSS without asking the model to
report them. A protected local cache lets the separate desktop history worker
read these samples. Ambiguous and unobserved calls remain unknown.

The process sampler in `../host/process-sampler.ts` feeds this module. The
public use is `commandProcessResource` from `history.ts` in session telemetry.

License: this module is distributed under the MIT License in the repository-root
`LICENSE` file.
