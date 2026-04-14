#!/usr/bin/env python3
"""Run the Notion → Obsidian sync script with the correct env vars."""

import os
import subprocess

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

env = os.environ.copy()
env.update({
    "NOTION_TOKEN": os.environ.get("NOTION_TOKEN", ""),
    "NOTION_DATABASE_ID": os.environ.get("NOTION_DATABASE_ID", ""),
    "OBSIDIAN_VAULT_PATH": os.environ.get("OBSIDIAN_VAULT_PATH", "/Users/asteray/Downloads/vocab_dump"),
    "OBSIDIAN_VOCAB_FOLDER": os.environ.get("OBSIDIAN_VOCAB_FOLDER", "Vocab_ao3"),
})

subprocess.run(["npm", "run", "sync"], cwd=PROJECT_DIR, env=env, check=True)
