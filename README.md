# NurseAunty prototype - published demo

**Open it here: https://levine63.github.io/NurseAunty-Demo/**

This repository is a **deployment target, not a source of truth.** It holds one build of
the NurseAunty prototype demo and nothing else. Every publish replaces its entire contents
with a single fresh commit, so there is no history here to read.

The application lives in a separate, private repository. Its canonical tester URL is
`https://hygieneheroes.berkeley.edu/nurseaunty/demo/`. Both are built by the same script
from the same commit; when they differ they are showing different commits, and each page
carries a `nurse-aunty-source-commit` meta tag that says which.

## What this is not

NurseAunty is an **unreviewed prototype**. It is not approved for real care, for field use,
or for use with real patients, and every screen says so. It carries **synthetic data only**
- no real person's information is in it. Its clinical content, translations, artwork and
rights are pending review; the guideline pack it runs is a draft.

Do not use it to make a decision about anyone's health.

## Checking a deployment

`check.html` asks this server for every file this package should contain and names anything
missing or truncated.
