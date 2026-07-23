// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick
import QtQuick.Effects

MultiEffect {
  property bool invert: false
  property bool cached: false

  maskEnabled: true
  maskInverted: invert
  maskThresholdMin: 0.0
  maskSpreadAtMin: 1.0
  maskThresholdMax: 1.0
  maskSpreadAtMax: 0.0
  autoPaddingEnabled: false
}
