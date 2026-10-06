import WidgetKit

let appGroupID = "group.com.alvarocarpintero.taskbot"

enum SharedSettings {
    static let defaults = UserDefaults(suiteName: appGroupID)
}

enum WidgetReloader {
    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
