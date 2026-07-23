// SPDX-License-Identifier: GPL-3.0-or-later

import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import Fk
import Fk.Widgets as W

W.PageBase {
  id: root

  property string configuredAddress: ""
  property int configuredPort: 9527

  Image {
    anchors.fill: parent
    source: Config.lobbyBg
    fillMode: Image.PreserveAspectCrop
  }

  Rectangle {
    width: Math.min(parent.width * 0.86, 520)
    height: Math.min(parent.height * 0.82, 430)
    anchors.centerIn: parent
    color: "#EAF9FAFB"
    radius: 18
    border.color: "#4464748B"

    ColumnLayout {
      anchors.fill: parent
      anchors.margins: 36
      spacing: 18

      Item { Layout.fillHeight: true }

      Text {
        text: qsTr("FreeKill Web")
        font.pixelSize: 32
        font.bold: true
        Layout.alignment: Qt.AlignHCenter
      }

      Text {
        text: qsTr("服务器已由网页部署配置，请登录或自动注册账号。")
        font.pixelSize: 16
        color: "#475569"
        wrapMode: Text.WordWrap
        horizontalAlignment: Text.AlignHCenter
        Layout.fillWidth: true
      }

      TextField {
        id: usernameEdit
        Layout.fillWidth: true
        maximumLength: 32
        placeholderText: qsTr("Username")
        selectByMouse: true
      }

      TextField {
        id: passwordEdit
        Layout.fillWidth: true
        maximumLength: 32
        placeholderText: qsTr("Password")
        passwordCharacter: "*"
        echoMode: TextInput.Password
        selectByMouse: true
        onAccepted: root.login()
      }

      Button {
        text: qsTr("LOGIN (Auto-registration)")
        Layout.fillWidth: true
        enabled: configuredAddress.length > 0 && configuredPort > 0 &&
          usernameEdit.text.trim().length > 0 && passwordEdit.text.length > 0
        onClicked: root.login()
      }

      Text {
        text: configuredAddress.length > 0
          ? qsTr("目标服务器：%1:%2").arg(configuredAddress).arg(configuredPort)
          : qsTr("网页部署缺少服务器配置")
        color: configuredAddress.length > 0 ? "#64748B" : "#B91C1C"
        font.pixelSize: 13
        Layout.alignment: Qt.AlignHCenter
      }

      Item { Layout.fillHeight: true }
    }
  }

  function loadDeploymentConfig() {
    configuredAddress = Backend.configuredServerAddress();
    configuredPort = Backend.configuredServerPort();
    Config.serverAddr = configuredAddress;
    Config.serverPort = configuredPort;

    const saved = Config.findFavorite(configuredAddress, configuredPort);
    usernameEdit.text = saved?.username ?? "";
    passwordEdit.text = saved?.password ?? "";
    usernameEdit.forceActiveFocus();
  }

  function login() {
    const username = usernameEdit.text.trim();
    const password = passwordEdit.text;
    if (!configuredAddress || !configuredPort || !username || !password) return;

    Config.serverAddr = configuredAddress;
    Config.serverPort = configuredPort;
    Config.screenName = username;
    Config.password = password;
    Config.addFavorite(configuredAddress, configuredPort, "", username, password);
    App.setBusy(true);
    Backend.joinServer(configuredAddress, configuredPort);
    ClientInstance.setLoginInfo(username, password);
  }

  function enterLobby(sender, data) {
    Config.lastLoginServer = configuredAddress;
    App.enterNewPage(Qt.createComponent("Fk.Pages.Lobby", "Lobby"));
    App.setBusy(false);
    Cpp.notifyServer("RefreshRoomList", "");
    Config.saveConf();
  }

  Component.onCompleted: {
    addCallback(Command.EnterLobby, enterLobby);
    loadDeploymentConfig();
  }
}
