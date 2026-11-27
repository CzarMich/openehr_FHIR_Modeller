#!/bin/sh
set -eu
source_root=${1:?NuGet package directory required}
destination=${2:?Notice output directory required}
mkdir -p "$destination"
find "$source_root" -type f \( -iname '*license*' -o -iname '*notice*' -o -name '*.nuspec' \) -exec sh -c '
  source_root=$1
  destination=$2
  shift 2
  for source_file do
    relative=${source_file#"$source_root"/}
    target="$destination/$relative"
    mkdir -p "$(dirname "$target")"
    cp "$source_file" "$target"
  done
' sh "$source_root" "$destination" {} +
