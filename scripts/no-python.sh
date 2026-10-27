#!/usr/bin/env bash
# The repository's no-Python rule, in one place: no Python file (a `.py` source, tracked, untracked,
# written by a ticket generator, or bytecode), and no Python config file, at the root **or in any
# subfolder** (a `bench/pyproject.toml` is as much Python as a root one).
#
# CI runs this as its first step (before npm ci, so Python fails the build at once), and
# scripts/check.sh calls no_python at the start and again at the end, after the ticket generators
# have written their trees. Everything here is a shell check on node-only code: this repo has no
# Python runtime, and `npm ci` is the only install.
set -euo pipefail

# File names, matched anywhere in the tree. `*.py` already covers setup.py, manage.py, conftest.py.
PY_CONFIG_NAMES="requirements.txt requirements-dev.txt pyproject.toml setup.cfg pytest.ini tox.ini .python-version Pipfile Pipfile.lock poetry.lock environment.yml mypy.ini ruff.toml .flake8 .ruff_cache"

no_python() {
	local bad n pred=()
	bad=$(git ls-files | grep -E '\.(py|pyc|pyo|pyi|pyz)$|/__pycache__/' || true)
	[ -z "$bad" ] || { echo "tracked Python files are not allowed:"; echo "$bad"; return 1; }
	for n in $PY_CONFIG_NAMES; do pred+=( -o -name "$n" ); done
	bad=$(find . \( -name node_modules -o -name .git \) -prune -o \
		\( -name '*.py' -o -name '*.pyc' -o -name '*.pyo' -o -name '*.pyi' -o -name '*.pyz' -o -name '__pycache__' "${pred[@]}" \) -print || true)
	[ -z "$bad" ] || { echo "Python files (untracked and generated too) are not allowed:"; echo "$bad"; return 1; }
	bad=$(git ls-files | grep -E '(^|/)('"$(echo "$PY_CONFIG_NAMES" | tr ' ' '|')"')$' || true)
	[ -z "$bad" ] || { echo "Python config files are not allowed, at the root or in any folder:"; echo "$bad"; return 1; }
	return 0
}

# Run directly (CI): check from the repository root.
if [ "$(basename "${BASH_SOURCE[0]}")" = "$(basename "${0}")" ]; then
	cd "$(dirname "${BASH_SOURCE[0]}")/.."
	no_python
	echo "no Python files, no Python config"
fi
