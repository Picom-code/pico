# Security

pico runs an agent that can execute commands and edit files on your machine, so we take reports seriously.

**Please do not open public issues for vulnerabilities.** Report them privately through
[GitHub security advisories](https://github.com/Picom-code/pico/security/advisories/new).
We aim to reply within 72 hours.

In scope:
- the engine API (auth token, loopback binding, phone pairing)
- approval bypasses (commands running without `/yolo` or an approval)
- the installer (`install.sh`, `install.ps1`)
- path traversal in file attachments, undo checkpoints or the web app

Bugs in Hermes Agent itself should go to [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
