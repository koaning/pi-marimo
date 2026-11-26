NOTEBOOK ?= scratch.py

.PHONY: dev check

# Run pi with the pi-marimo in this folder, not an installed copy.
# --no-extensions stops pi from also loading installed extensions (pi-marimo included);
# the explicit -e path still loads. Override the notebook with: make dev NOTEBOOK=other.py
dev:
	pi --no-extensions -e ./ --marimo $(NOTEBOOK)

check:
	npm run check
