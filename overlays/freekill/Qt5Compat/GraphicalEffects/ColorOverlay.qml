// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

MultiEffect {
  property color color: "transparent"
  property bool cached: false

  colorization: 1.0
  colorizationColor: color
  autoPaddingEnabled: false
}
