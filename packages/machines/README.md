# machines

The SSH transport shared by the packages that reach another machine: one
command over `ssh` with stdin streamed, stdout collected or streamed to a
file, and stderr handed over line by line. Callers talk to an `Exec`, so tests
run the other machine in-process.
