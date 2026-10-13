# Additional permission for Google Play services (GPL-3.0 section 7)

Wicaby is free software under the [GNU General Public License, version 3 or later](LICENSE)
(SPDX: `GPL-3.0-or-later`). Its copyright holders grant the additional permission below, as
section 7 of that licence allows. The text follows the template the Free Software Foundation
gives in its [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#GPLIncompatibleLibs); the
sentence in braces is left out, because the source code of Google Play services is not
available to everyone.

```
Copyright (C) 2026 Wika and the Wicaby contributors

This program is free software; you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation; either version 3 of the License, or (at your option)
any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, see <https://www.gnu.org/licenses>.

Additional permission under GNU GPL version 3 section 7

If you modify this Program, or any covered work, by linking or combining
it with the Google Play services Cast libraries and their dependencies
(or a modified version of those libraries), containing parts covered by
the terms of the Android Software Development Kit License Agreement and
the Google APIs Terms of Service, the licensors of this Program grant you
additional permission to convey the resulting work.
```

## Scope

- **What it covers:** linking Wicaby with the Google Cast libraries of Google Play services
  (`com.google.android.gms:play-services-cast-framework`, used directly or through
  `androidx.media3:media3-cast`) and the Play services libraries they depend on. This is what
  the optional `gplay` flavour of the Android mobile app does. Nothing else: no other
  non-free library is covered.
- **Which builds need it:** only `gplay`. The default `foss` flavour, the TV app and the Windows
  app link no Google Play services and are plain `GPL-3.0-or-later`.
- **Third-party code:** the permission covers only code whose copyright holders granted it.
  The Jellyfin Media3 FFmpeg decoder is GPL-3.0 without this permission, so the `gplay` flavour
  does not include it (the server transcodes those audio codecs instead). Every other
  third-party component keeps its own licence: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Contributions:** contributions are accepted under `GPL-3.0-or-later` together with this
  permission (see [CONTRIBUTING.md](CONTRIBUTING.md)). Code from authors who have not agreed to
  it cannot go into the `gplay` flavour until they agree or the code is rewritten.
- **Your copies:** as section 7 says, when you convey a copy of Wicaby you may remove this
  additional permission from that copy, or from any part of it. If you modify Wicaby, you may
  extend this permission to your version, but you do not have to.
