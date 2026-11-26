"""Ein Prozess teilt SQLite und den Importstatus mit mehreren Anfrage-Threads."""

import os

bind = "0.0.0.0:" + os.environ.get("PORT", "10000")
workers = 1
worker_class = "gthread"
threads = 4
timeout = 180
graceful_timeout = 60
preload_app = False
accesslog = None
errorlog = "-"
capture_output = True
