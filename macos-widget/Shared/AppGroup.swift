import Foundation

// Grupo de apps que comparten la app y el widget (la clave de DASH_TOKEN, la página del widget).
// Sale del bundle id, que se fija en Config.xcconfig / Local.xcconfig: group.<prefijo>.taskbot
let taskbotAppGroupID: String = {
    let id = Bundle.main.bundleIdentifier ?? "com.example.taskbot"
    let base = id.hasSuffix(".macoswidget") ? String(id.dropLast(".macoswidget".count)) : id
    return "group." + base
}()
