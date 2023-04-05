//
// Copyright 2015-2021 by Garmin Ltd. or its subsidiaries.
// Subject to Garmin SDK License Agreement and Wearables
// Application Developer Agreement.
//

import Toybox.Lang;
import Toybox.WatchUi;

//! Handles navigating between views
class TestPersonalityDelegate extends WatchUi.BehaviorDelegate {
    private var _page as Number = 1;

    //! Constructor
    public function initialize() {
        BehaviorDelegate.initialize();
    }

    //! Handle going to the next page
    //! @return true if handled, false otherwise
    public function onNextPage() as Boolean {
        return onMenu();
    }

    //! On a menu event, go to the next page
    //! @return true if handled, false otherwise
    public function onMenu() as Boolean {
        if (_page == 3) {
            _page = 1;
        } else {
            _page++;
        }

        switchView();
        return true;
    }

    //! Switch to the current view
    private function switchView() as Void {
        var newView;

        if (_page == 1) {
            newView = new $.TestPersonalitySectionOneView();
        } else if (_page == 2) {
            newView = new $.TestPersonalitySectionTwoView();
        } else {
            newView = new $.TestPersonalitySectionThreeView();
        }

        WatchUi.switchToView(newView, self, WatchUi.SLIDE_IMMEDIATE);
    }
}
