// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

MultiEffect {
  property real radius: 0
  property bool transparentBorder: false
  property bool cached: false

  blurEnabled: radius > 0
  blur: Math.min(1.0, Math.max(0.0, radius / 64.0))
  blurMax: Math.max(16, Math.min(64, Math.ceil(radius)))
  autoPaddingEnabled: transparentBorder
}
