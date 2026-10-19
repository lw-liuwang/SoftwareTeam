# testbed-stub (51-04 container stub payload)

A minimal zero-token stub-runtime SoftwareTeam baked into the softwareteam-testbed image so the L3
daemon-in-container leg can `SoftwareTeam up` a settled topology without a live LLM. The single
seat runs the deterministic 51-01 stub harness. Not a product SoftwareTeam — it exists only to
prove the container boots a real daemon and settles a real topology headlessly.
