//
// Copyright 2015-2021 by Garmin Ltd. or its subsidiaries.
// Subject to Garmin SDK License Agreement and Wearables
// Application Developer Agreement.
//

import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Time.Gregorian;
import Toybox.UserProfile;
import Toybox.WatchUi;

//! Shows user information about sleep time, step length, and heart rate
class TestPersonalitySectionTwoView extends WatchUi.View {
    private var _sleepTimePrefixStr as String;
    private var _runStepLengthPrefixStr as String;
    private var _walkStepLengthPrefixStr as String;
    private var _restingHeartRatePrefixStr as String;
    private var _heartRateUnitsStr as String;
    private var _stepLengthUnitsStr as String;
    private var _notSetStr as String;

    //! Constructor
    public function initialize() {
        View.initialize();

        _sleepTimePrefixStr =
            WatchUi.loadResource($.Rez.Strings.SleepTimePrefix) as String;
        _runStepLengthPrefixStr =
            WatchUi.loadResource($.Rez.Strings.RunningStepLengthPrefix) as
            String;
        _walkStepLengthPrefixStr =
            WatchUi.loadResource($.Rez.Strings.WalkingStepLengthPrefix) as
            String;
        _restingHeartRatePrefixStr =
            WatchUi.loadResource($.Rez.Strings.RestingHeartRatePrefix) as
            String;
        _stepLengthUnitsStr =
            WatchUi.loadResource($.Rez.Strings.MMUnits) as String;
        _notSetStr = WatchUi.loadResource($.Rez.Strings.ItemNotSet) as String;
        _heartRateUnitsStr =
            WatchUi.loadResource($.Rez.Strings.BPMUnits) as String;
    }

    //! Load your resources here
    //! @param dc Device context
    public function onLayout(dc as Dc) as Void {
        setLayout($.Rez.Layouts.SectionTwoLayout(dc));
    }

    //! Update the view
    //! @param dc Device Context
    public function onUpdate(dc as Dc) as Void {
        var profile = UserProfile.getProfile();

        var string = _sleepTimePrefixStr;

        var sleepTime = profile.sleepTime;
        if (sleepTime != null) {
            var hours = sleepTime.divide(Gregorian.SECONDS_PER_HOUR).value();
            var sleepTimeValue = sleepTime.value();
            var minutes =
                (sleepTimeValue - hours * Gregorian.SECONDS_PER_HOUR) /
                Gregorian.SECONDS_PER_MINUTE;
            var seconds =
                sleepTimeValue -
                hours * Gregorian.SECONDS_PER_HOUR -
                minutes * Gregorian.SECONDS_PER_MINUTE;
            string +=
                hours.format("%02u") +
                ":" +
                minutes.format("%02u") +
                ":" +
                seconds.format("%02u");
        } else {
            string += _notSetStr;
        }
        (findDrawableById("SleepTimeLabel") as Text).setText(string);

        string = _runStepLengthPrefixStr;
        var runningStepLength = profile.runningStepLength;
        if (runningStepLength != null) {
            string += runningStepLength.toString() + _stepLengthUnitsStr;
        } else {
            string += _notSetStr;
        }
        (findDrawableById("RunStepLengthLabel") as Text).setText(string);

        string = _walkStepLengthPrefixStr;
        var walkingStepLength = profile.walkingStepLength;
        if (walkingStepLength != null) {
            string += walkingStepLength.toString() + _stepLengthUnitsStr;
        } else {
            string += _notSetStr;
        }
        (findDrawableById("WalkStepLengthLabel") as Text).setText(string);

        string = _restingHeartRatePrefixStr;
        var restingHeartRate = profile.restingHeartRate;
        if (restingHeartRate != null) {
            string += restingHeartRate.toString() + _heartRateUnitsStr;
        } else {
            string += _notSetStr;
        }
        (findDrawableById("RestingHeartRateLabel") as Text).setText(string);

        View.onUpdate(dc);
    }
}
