// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

Item {
  id: root

  property Item source
  property real hue: 0
  property real saturation: 1
  property real lightness: 0
  property bool cached: false

  implicitWidth: source ? source.width : 0
  implicitHeight: source ? source.height : 0

  MultiEffect {
    anchors.fill: parent
    source: root.source
    saturation: Math.max(-1.0, Math.min(1.0, root.saturation - 1.0))
    colorization: Math.max(0.0, Math.min(1.0, root.saturation))
    colorizationColor: Qt.hsla(
      root.hue,
      Math.max(0.0, Math.min(1.0, root.saturation)),
      Math.max(0.0, Math.min(1.0, 0.5 + root.lightness * 0.5)),
      1.0)
    autoPaddingEnabled: false
  }
}
