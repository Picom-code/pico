"""Launch pico.server with thread names in the log format so the eval can attribute Hermes'
per-API-call usage lines ("API call #N: ... in=X out=Y ... cache=R/X") to sessions.
Runs the unmodified engine: `python eval/lib/engine_main.py` with cwd=engine/."""
import logging
import os
import sys

sys.path.insert(0, os.getcwd())
logging.basicConfig(level=os.environ.get("PICO_LOG", "INFO"),
                    format="%(asctime)s [%(threadName)s] %(name)s %(levelname)s %(message)s")
from pico.server import main  # noqa: E402

main()
