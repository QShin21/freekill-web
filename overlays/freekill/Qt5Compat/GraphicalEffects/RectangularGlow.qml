// SPDX-License-Identifier: GPL-3.0-or-later
import QtQuick

Rectangle {
  property real glowRadius: 0
  property real spread: 0
  property real cornerRadius: 0
  property bool cached: false

  radius: Math.max(cornerRadius, glowRadius)
}
