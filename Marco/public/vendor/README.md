# Vendored d2ttk engine (https://d2ttk.com)

Verbatim copies of d2ttk's static JS chunks, fetched 2026-08-04. They power the
overlay's Optimise clone: `stats.*.js` (TTK math + perk-effects dataset),
`constants.*.js` (stat hashes), `build-code.*.js` (damage tables + profile
resolver) plus their tiny module deps. Filenames must stay unchanged so their
relative imports resolve. `optimise.js` is Marco's own adapter (port of the
WeaponPage optimise-mode logic).

To refresh after a d2ttk update: fetch the current weapon page, read the new
chunk names from its HTML/imports, re-download, and update the import map in
optimise.js.
