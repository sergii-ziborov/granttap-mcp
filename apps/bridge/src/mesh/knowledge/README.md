# Mesh knowledge projection

`active.ts` filters a Project's bounded phone projection using recorded
supersession links. The Engine journal remains the durable source and retains
the complete audit history. A correction only hides an earlier record when both
records have the same Project, visibility, category, and repository scope.

`write.ts` accepts an explicit human decision for an existing Task on a locally
bound Project, records it through Engine Memory, and returns a `recorded` receipt
only after the Engine confirms. A correction carries the old record ID; the
Engine validates its scope. The phone may replay the same ID after a lost reply.
This is not a migration of old chats into verified knowledge.

MIT License.
