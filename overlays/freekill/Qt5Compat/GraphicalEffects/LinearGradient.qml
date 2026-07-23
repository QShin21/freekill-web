// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

Item {
  id: root

  property Item source
  property alias gradient: gradientFill.gradient
  property point start: Qt.point(0, 0)
  property point end: Qt.point(0, height)
  property bool cached: false

  implicitWidth: source ? source.width : 0
  implicitHeight: source ? source.height : 0

  Rectangle {
    id: gradientFill
    anchors.fill: parent
    visible: false
  }

  MultiEffect {
    anchors.fill: parent
    source: gradientFill
    maskEnabled: root.source !== null
    maskSource: root.source
    maskThresholdMin: 0.0
    maskSpreadAtMin: 1.0
    maskThresholdMax: 1.0
    maskSpreadAtMax: 0.0
    autoPaddingEnabled: false
  }
}
