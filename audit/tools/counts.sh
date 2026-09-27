#!/usr/bin/env bash
# usage: counts.sh audit/manifest/files.tsv
awk -F'\t' 'NR==1{for(i=1;i<=NF;i++) if($i=="status") s=i; next}
{c[$s]++; n++} END{print "total",n; for(k in c) print k, c[k]}' "$1"
