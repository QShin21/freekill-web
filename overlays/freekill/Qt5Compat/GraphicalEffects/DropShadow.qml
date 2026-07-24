// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

MultiEffect {
  property color color: "black"
  property real radius: 8
  property real samples: 0
  property real spread: 0
  property real horizontalOffset: 0
  property real verticalOffset: 0
  property bool transparentBorder: false
  property bool cached: false

  shadowEnabled: true
  shadowColor: color
  shadowBlur: Math.min(1.0, Math.max(0.0, radius / 32.0))
  shadowHorizontalOffset: horizontalOffset
  shadowVerticalOffset: verticalOffset
  shadowScale: 1.0 + Math.max(0.0, spread) * 0.08
  autoPaddingEnabled: transparentBorder
}
