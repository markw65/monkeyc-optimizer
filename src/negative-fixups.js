/*
 * This is strange. It pretty much has to be a bug in the sdk,
 * but its the same in every sdk.
 *
 * ${sdk}/bin/api.mir describes the Toybox api down to every module,
 * class, function, enum and constant, together with the enum
 * and constant values.
 *
 * The problem is that every enum or constant with a negative
 * value, appears with the corresponding positive value in api.mir.
 * So eg Graphics.COLOR_TRANSPARENT should be -1, but instead, it has
 * the value 1.
 *
 * This is a (currently somewhat ad-hoc) list of the negative constants
 * so we can fix them after reading api.mir.
 */
export const negativeFixups = [
  "Toybox.Communications.BLE_CONNECTION_UNAVAILABLE",
  "Toybox.Communications.INVALID_HTTP_BODY_IN_REQUEST",
  "Toybox.Communications.REQUEST_CANCELLED",
  "Toybox.Communications.UNSUPPORTED_CONTENT_TYPE_IN_RESPONSE",
  "Toybox.Communications.UNABLE_TO_PROCESS_IMAGE",
  "Toybox.Communications.NETWORK_RESPONSE_OUT_OF_MEMORY",
  "Toybox.Communications.BLE_REQUEST_CANCELLED",
  "Toybox.Communications.INVALID_HTTP_METHOD_IN_REQUEST",
  "Toybox.Communications.BLE_NO_DATA",
  "Toybox.Communications.INVALID_HTTP_HEADER_FIELDS_IN_REQUEST",
  "Toybox.Communications.BLE_ERROR",
  "Toybox.Communications.NETWORK_RESPONSE_TOO_LARGE",
  "Toybox.Communications.INVALID_HTTP_BODY_IN_NETWORK_RESPONSE",
  "Toybox.Communications.BLE_REQUEST_TOO_LARGE",
  "Toybox.Communications.UNABLE_TO_PROCESS_MEDIA",
  "Toybox.Communications.REQUEST_CONNECTION_DROPPED",
  "Toybox.Communications.BLE_UNKNOWN_SEND_ERROR",
  "Toybox.Communications.BLE_QUEUE_FULL",
  "Toybox.Communications.STORAGE_FULL",
  "Toybox.Communications.BLE_SERVER_TIMEOUT",
  "Toybox.Communications.INVALID_HTTP_HEADER_FIELDS_IN_NETWORK_RESPONSE",
  "Toybox.Communications.SECURE_CONNECTION_REQUIRED",
  "Toybox.Communications.NETWORK_REQUEST_TIMED_OUT",
  "Toybox.Communications.BLE_HOST_TIMEOUT",
  "Toybox.Communications.UNABLE_TO_PROCESS_HLS",
  "Toybox.Graphics.COLOR_TRANSPARENT",
  "Toybox.AntPlus.INVALID_SPEED",
  "Toybox.AntPlus.INVALID_CADENCE",
  "Toybox.WatchUi.LAYOUT_VALIGN_START",
  "Toybox.WatchUi.LAYOUT_VALIGN_TOP",
  "Toybox.WatchUi.LAYOUT_VALIGN_BOTTOM",
  "Toybox.WatchUi.LAYOUT_VALIGN_CENTER",
  "Toybox.WatchUi.LAYOUT_HALIGN_RIGHT",
  "Toybox.WatchUi.LAYOUT_HALIGN_CENTER",
  "Toybox.WatchUi.LAYOUT_HALIGN_START",
  "Toybox.WatchUi.LAYOUT_HALIGN_LEFT",
];
