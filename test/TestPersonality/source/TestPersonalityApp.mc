//
// Copyright 2015-2021 by Garmin Ltd. or its subsidiaries.
// Subject to Garmin SDK License Agreement and Wearables
// Application Developer Agreement.
//

import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

//! This app demonstrates how to access user profile data from a device.
//! Press the menu to cycle through three screens of user profile data.
class TestPersonalityApp extends Application.AppBase {
    //! Constructor
    public function initialize() {
        AppBase.initialize();
        System.println(Rez.Styles.fontinfo.font);
        System.println(screenWidth());
    }

    (:personality)
    public function screenWidth() as Number {
        return Rez.Styles.system_size__screen.width;
    }

    (:no_personality)
    public function screenWidth() as Number {
        return -1;
    }

    //! Handle app startup
    //! @param state Startup arguments
    public function onStart(state as Dictionary?) as Void {}

    //! Handle app shutdown
    //! @param state Shutdown arguments
    public function onStop(state as Dictionary?) as Void {}

    //! Return the initial view for the app
    //! @return Array Pair [View, Delegate]
    public function getInitialView() as Array<Views or InputDelegates>? {
        return (
            [
                new $.TestPersonalitySectionOneView(),
                new $.TestPersonalityDelegate(),
            ] as Array<Views or InputDelegates>
        );
    }
}
