import WidgetKit

let appGroupID = taskbotAppGroupID

enum SharedSettings {
    static let defaults = UserDefaults(suiteName: appGroupID)
}

enum WidgetReloader {
    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
