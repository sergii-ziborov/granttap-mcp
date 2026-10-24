# Project relationship wire contract

`index.ts` validates the Engine's bounded static contract report. Repository IDs
must belong to its selected set; locations are relative paths in the source
repository, and the relation remains `contract_match`. Source excerpts,
absolute paths, foreign identities and unexpected fields fail closed.

The public framed-client and parser tests live with the consuming feature in
`../../runtime/project-relationships/tests/`. Runtime projection is documented
in that feature's README.
