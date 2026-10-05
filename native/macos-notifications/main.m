#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <UserNotifications/UserNotifications.h>
#import <os/log.h>

static void fail(NSString *message, int code) {
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(code);
}

static void output(id value, int code) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!json) fail(error.localizedDescription, 5);
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  exit(code);
}

static NSString *authorizationName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusNotDetermined: return @"notDetermined";
    case UNAuthorizationStatusDenied: return @"denied";
    case UNAuthorizationStatusAuthorized: return @"authorized";
    case UNAuthorizationStatusProvisional: return @"provisional";
    default: return @"unknown";
  }
}

static NSURL *notificationURL(id value) {
  if (![value isKindOfClass:NSString.class] || [value length] > 8192) return nil;
  NSURLComponents *url = [NSURLComponents componentsWithString:value];
  BOOL editorScheme = [@[@"vscode", @"vscode-insiders", @"vscodium", @"vscodium-insiders", @"code-oss"] containsObject:url.scheme];
  BOOL project = [url.host isEqualToString:@"file"] && [url.path hasPrefix:@"/"] && url.path.length > 1 && !url.query && !url.fragment;
  // Retain support for already-delivered banners from older extension versions.
  BOOL legacy = [url.host isEqualToString:@"koltyakov.varro"] && [url.path isEqualToString:@"/notification"];
  if (!editorScheme || (!project && !legacy) || url.user || url.password || url.port) return nil;
  return url.URL;
}

static NSDictionary *boundsJSON(CGRect bounds) {
  return @{ @"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
            @"width": @(bounds.size.width), @"height": @(bounds.size.height) };
}

static void editorWindows(const char *argument) {
  char *end = NULL;
  long processID = strtol(argument, &end, 10);
  if (!argument[0] || *end || processID <= 0 || processID > INT_MAX) fail(@"Invalid editor process ID.", 2);
  if (![NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)processID]) {
    fail(@"The editor process is not a running desktop application.", 7);
  }
  uint32_t displayCount = 0;
  if (CGGetActiveDisplayList(0, NULL, &displayCount) != kCGErrorSuccess) fail(@"Could not read active displays.", 7);
  CGDirectDisplayID *displayIDs = calloc(MAX(displayCount, 1), sizeof(CGDirectDisplayID));
  if (!displayIDs) fail(@"Could not allocate display list.", 7);
  if (CGGetActiveDisplayList(displayCount, displayIDs, &displayCount) != kCGErrorSuccess) {
    free(displayIDs);
    fail(@"Could not read active displays.", 7);
  }
  NSMutableArray *screens = [NSMutableArray array];
  for (uint32_t i = 0; i < displayCount; i++) [screens addObject:boundsJSON(CGDisplayBounds(displayIDs[i]))];
  free(displayIDs);

  // Geometry, owner IDs and opacity are available without screen recording or Accessibility access.
  // Do not request window names or capture any screen pixels.
  NSArray *entries = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  if (!entries) fail(@"Could not read on-screen window bounds.", 7);
  NSMutableArray *windows = [NSMutableArray array];
  for (NSDictionary *entry in entries) {
    double alpha = [entry[(__bridge NSString *)kCGWindowAlpha] doubleValue];
    NSInteger layer = [entry[(__bridge NSString *)kCGWindowLayer] integerValue];
    if (alpha <= 0 || layer < 0) continue;
    pid_t ownerID = [entry[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    // Dock owns a transparent full-display overlay whose window-level alpha is still 1.
    // It is desktop chrome, not an opaque application covering the editor.
    if (layer > 0 && [[NSRunningApplication runningApplicationWithProcessIdentifier:ownerID].bundleIdentifier isEqualToString:@"com.apple.dock"]) continue;
    CGRect bounds;
    NSDictionary *dictionary = entry[(__bridge NSString *)kCGWindowBounds];
    if (!dictionary || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)dictionary, &bounds)) continue;
    NSMutableDictionary *window = [boundsJSON(bounds) mutableCopy];
    window[@"editor"] = ownerID == processID && layer == 0 ? @YES : @NO;
    window[@"opaque"] = alpha >= 0.999 ? @YES : @NO;
    [windows addObject:window];
  }
  output(@{ @"screens": screens, @"windows": windows }, 0);
}

@interface VarroNotifications : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@end

@implementation VarroNotifications

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
  (void)notification;
  [UNUserNotificationCenter currentNotificationCenter].delegate = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 45 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    fail(@"Varro notification timed out. Check the macOS permission prompt or System Settings > Notifications > Varro.", 4);
  });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
  os_log(OS_LOG_DEFAULT, "Varro helper launch: version=5 argumentCount=%{public}lu", (unsigned long)args.count);
  if (args.count == 1) {
    // Notification Center may relaunch the app after its banner is clicked.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
    return;
  }
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  if (args.count == 2 && [args[1] isEqualToString:@"--version"]) {
    output(@{ @"name": @"Varro", @"version": @"5", @"bundleId": NSBundle.mainBundle.bundleIdentifier }, 0);
  } else if (args.count == 2 && [args[1] isEqualToString:@"--diagnose"]) {
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      output(@{
        @"name": @"Varro",
        @"bundleId": NSBundle.mainBundle.bundleIdentifier,
        @"authorization": authorizationName(settings.authorizationStatus),
        @"alertsEnabled": @(settings.alertSetting == UNNotificationSettingEnabled),
        @"alertStyle": settings.alertStyle == UNAlertStyleNone ? @"none" : settings.alertStyle == UNAlertStyleBanner ? @"banners" : @"alerts",
        @"notificationCenterEnabled": @(settings.notificationCenterSetting == UNNotificationSettingEnabled)
      }, 0);
    }];
  } else if (args.count == 3 && [args[1] isEqualToString:@"--delivered"]) {
    NSString *identifier = args[2];
    [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
      NSMutableArray *matches = [NSMutableArray array];
      for (UNNotification *item in notifications) {
        if ([item.request.identifier isEqualToString:identifier]) {
          [matches addObject:@{
            @"id": item.request.identifier,
            @"title": item.request.content.title,
            @"subtitle": item.request.content.subtitle,
            @"body": item.request.content.body,
            @"url": item.request.content.userInfo[@"url"] ?: @"",
            @"hasSound": @(item.request.content.sound != nil)
          }];
        }
      }
      output(matches, 0);
    }];
  } else if (args.count >= 5 && args.count <= 7 && [args[1] isEqualToString:@"--notify"]) {
    NSString *title = args[2];
    NSString *subtitle = args[3];
    NSString *body = args[4];
    NSString *identifier = args.count >= 6 ? args[5] : NSUUID.UUID.UUIDString;
    NSString *url = args.count == 7 ? args[6] : @"";
    if (title.length > 256 || subtitle.length > 256 || body.length > 2000 || identifier.length > 256) {
      fail(@"Notification title, subtitle, body, or identifier exceeds its size limit.", 2);
    }
    if (url.length && !notificationURL(url)) fail(@"Invalid Varro notification URL.", 2);
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
        fail(@"Allow Varro in System Settings > Notifications and select Banners or Alerts.", 3);
      } else if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
          if (error) fail([@"Could not request Varro notification permission: " stringByAppendingString:error.localizedDescription], 3);
          if (!granted) fail(@"Allow Varro in System Settings > Notifications and select Banners or Alerts.", 3);
          [self deliverTitle:title subtitle:subtitle body:body identifier:identifier url:url];
        }];
      } else {
        [self deliverTitle:title subtitle:subtitle body:body identifier:identifier url:url];
      }
    }];
  } else {
    fail(@"Usage: varro-notifier --notify PROJECT CHAT DETAILS [ID [URL]] | --windows PID | --diagnose | --delivered ID | --version", 2);
  }
}

- (void)deliverTitle:(NSString *)title subtitle:(NSString *)subtitle body:(NSString *)body identifier:(NSString *)identifier url:(NSString *)url {
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = title;
  content.subtitle = subtitle;
  content.body = body;
  if (url.length) content.userInfo = @{ @"url": url };
  // Varro's sound setting is independent; the OS banner must never add a second sound.
  content.sound = nil;
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
  [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    if (error) fail([@"Could not deliver Varro notification: " stringByAppendingString:error.localizedDescription], 5);
    output(@{ @"status": @"accepted", @"id": identifier }, 0);
  }];
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  (void)center;
  (void)notification;
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))completionHandler {
  (void)center;
  NSURL *url = notificationURL(response.notification.request.content.userInfo[@"url"]);
  BOOL openWindow = [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier] && url != nil;
  os_log(OS_LOG_DEFAULT, "Varro notification response: action=%{public}@ hasURL=%{public}d validURL=%{public}d", response.actionIdentifier, response.notification.request.content.userInfo[@"url"] != nil, url != nil);
  dispatch_async(dispatch_get_main_queue(), ^{
    BOOL opened = openWindow && [NSWorkspace.sharedWorkspace openURL:url];
    os_log(OS_LOG_DEFAULT, "Varro notification handoff: requested=%{public}d opened=%{public}d", openWindow, opened);
    completionHandler();
    if (openWindow && !opened) fail(@"Could not open the project window in VS Code.", 6);
    exit(0);
  });
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "--windows") == 0) editorWindows(argv[2]);
    NSApplication *app = [NSApplication sharedApplication];
    static VarroNotifications *delegate;
    delegate = [VarroNotifications new];
    app.delegate = delegate;
    [app run];
  }
  return 0;
}
