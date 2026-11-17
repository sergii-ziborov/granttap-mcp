# Local store, remotes and folder Meshes

`local.ts` holds this computer's Mesh store. `remote.ts` is the one place a Git remote is touched:
a handoff's push and fetch (see the Mesh README).

## A folder Mesh never takes a repository with its own remote

A chat started in a folder without Git (`~/dev`) makes a Mesh named by the folder: its canonical
repository is `local:<path>`. When that chat goes on to work in `~/dev/app`, a clone with its own
remote, the Task stays in the folder Mesh with its history, and the execution records where it
worked. `folder-meshes.ts` keeps the repository out of that Mesh:

- The catalog does not bind a repository with a remote to a folder Mesh. A local repository without
  a remote may still join its parent folder's Mesh, as before.
- Routing (`MeshStore.projectIdForRepository` and `bindingForRepository`, which also pick a phone
  task's Mesh, a run's Project environment and Governance) passes over a folder Mesh's binding of such
  a repository, on any computer, so the repository's new chats go to its own Mesh at once.
- A binding an older runtime made for it on this computer is taken out of the folder Mesh the next
  time a chat in either is cataloged, with a `removedBindings` record, so a phone or another computer
  that still lists it does not bind it again; the repository's next chat binds it to its own Mesh.
  The Engine keeps its own copy of the old binding: it has no operation to remove one.
- The phone cannot add such a repository to a folder Mesh (`mesh.repository.edit` answers
  `invalid` and says why).

Tasks that already ran in the folder Mesh are not moved.

## A folder Mesh superseded by its folder's repository

A folder Mesh made while `~/dev/inbox` was a plain folder is left behind when that folder later
becomes a clone of a repository with its own Mesh: new chats in the folder land in the repository's
Mesh. The snapshot this computer publishes for the old Mesh then carries

```json
"project": { "projectId": "project-…", "name": "inbox", "canonicalRepositoryId": "local:/Users/…/inbox",
             "supersededBy": "project-<the repository's Mesh>" }
```

`project.supersededBy` (optional, a Project id) means: this Mesh's folder is now a Git checkout at
the same path, and the most recent chat at its root runs in the named Mesh, whose repository has
its own remote. The old Mesh keeps its tasks and stays published, so they remain visible and
searchable; a controller should leave it out of New Task and may point to the named Mesh instead.
The field is absent for every other Mesh, and it disappears again if the folder stops being a
checkout. It is read from this computer's own folders at publication and never stored: a snapshot
that comes back with it is merged without it. Phones that do not know the field ignore it (it is
inside `project`); a computer on an older runtime rejects a snapshot that carries it, which only
the superseded Mesh's snapshot does.

Tests: `tests/folder-meshes.test.ts`, `../../../../../tests/agentic/codex-workspace-binding.test.ts`.

License: [GrantTap Commercial Source License](../../../../../LICENSE).
