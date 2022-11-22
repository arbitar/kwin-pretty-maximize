#!/bin/bash

id="$(grep -oP '(?<=X-KDE-PluginInfo-Name=).*' metadata.desktop)"
[[ -f "$id.kwinscript" ]] || {
	echo "No packaged script named '$id.kwinscript' found"
	exit 1
}

if kpackagetool5 --list | grep "^$id$" > /dev/null; then
	kpackagetool5 --type=KWin/Script -u "$id.kwinscript"
else
	kpackagetool5 --type=KWin/Script -i "$id.kwinscript"
fi

mkdir -p ~/.local/share/kservices5
[ -e ~/".local/share/kservices5/$id.desktop" ] || ln -s ~/.local/share/kwin/scripts/"$id"/metadata.desktop ~/.local/share/kservices5/"$id".desktop