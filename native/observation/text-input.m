#import "text-input.h"
#import <sys/stat.h>
#import <unistd.h>

static NSString *inputSession, *inputDirectory, *inputRequest;
static dispatch_source_t inputTimer;
static BOOL applying;
static NSMutableSet *handled;
static UIView *firstResponder(UIView *view) {
    if (view.isFirstResponder) return view;
    for (UIView *child in view.subviews) { UIView *found = firstResponder(child); if (found) return found; }
    return nil;
}
static UIView *focusedField(void) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class] || scene.activationState != UISceneActivationStateForegroundActive) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) { UIView *view = firstResponder(window); if (view) return view; }
    }
    return nil;
}
// Search bars can expose an internal field editor as first responder. Resolve
// only its owning standard editor; never choose an unrelated visible field.
static UIView *standardEditor(UIView *responder) {
    for (UIView *view = responder; view; view = view.superview) {
        if ([view isKindOfClass:UITextField.class] || [view isKindOfClass:UITextView.class]) return view;
        if ([view isKindOfClass:UISearchBar.class]) {
            UISearchTextField *field = ((UISearchBar *)view).searchTextField;
            if (field.isFirstResponder || [responder isDescendantOfView:field] || responder == view) return field;
        }
    }
    return responder;
}
static BOOL editorFocused(UIView *editor) {
    UIView *responder = focusedField();
    return responder && standardEditor(responder) == editor;
}
static NSDictionary *target(UIView *view) {
    CGRect rect = view.window ? [view convertRect:view.bounds toCoordinateSpace:view.window.screen.coordinateSpace] : CGRectZero;
    return @{@"elementId": view.accessibilityIdentifier ?: (id)NSNull.null, @"type": NSStringFromClass(view.class),
        @"frame": @{@"x": @(rect.origin.x), @"y": @(rect.origin.y), @"width": @(rect.size.width), @"height": @(rect.size.height)}};
}
static NSString *fieldText(UIView *view) {
    return [view isKindOfClass:UITextField.class] ? ((UITextField *)view).text ?: @"" : ((UITextView *)view).text ?: @"";
}
static BOOL supported(UIView *view) { return [view isKindOfClass:UITextField.class] || [view isKindOfClass:UITextView.class]; }
static NSDictionary *snapshot(UIView *view) {
    id<UITextInput> field = (id<UITextInput>)view;
    NSString *text = fieldText(view);
    BOOL secure = ((id<UITextInputTraits>)view).secureTextEntry;
    return @{@"target": target(view), @"text": secure ? (id)NSNull.null : text, @"textLength": @(text.length),
        @"redacted": @(secure), @"composing": (field.markedTextRange ? @YES : @NO)};
}
static void respond(NSString *request, NSDictionary *value) {
    NSMutableDictionary *response = [value mutableCopy]; response[@"sessionId"] = inputSession; response[@"requestId"] = request;
    [[NSJSONSerialization dataWithJSONObject:response options:0 error:nil] writeToFile:[inputDirectory stringByAppendingPathComponent:@"response.json"] options:NSDataWritingAtomic error:nil];
}
static NSDictionary *readJSON(NSString *file) {
    NSString *path = [inputDirectory stringByAppendingPathComponent:file];
    NSDictionary *attr = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    if (!attr || [attr fileSize] > 1024 * 1024) return nil;
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data || data.length > 1024 * 1024) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
// UIKit insertText is programmatic and may bypass shouldChange delegate methods.
// Ask once explicitly, then forward all callbacks through a short-lived proxy;
// if a UIKit version asks again for the same edit, reuse that answer.
@interface ISimBotValidationDelegate : NSObject <UITextFieldDelegate, UITextViewDelegate>
@property(nonatomic, strong) id original;
@property(nonatomic) NSRange approvedRange;
@property(nonatomic, copy) NSString *approvedText;
@end
@implementation ISimBotValidationDelegate
- (BOOL)respondsToSelector:(SEL)selector { return [super respondsToSelector:selector] || [self.original respondsToSelector:selector]; }
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (BOOL)textField:(UITextField *)field shouldChangeCharactersInRange:(NSRange)range replacementString:(NSString *)text {
    if (NSEqualRanges(range, self.approvedRange) && [text isEqual:self.approvedText]) return YES;
    return ![self.original respondsToSelector:_cmd] || [self.original textField:field shouldChangeCharactersInRange:range replacementString:text];
}
- (BOOL)textView:(UITextView *)view shouldChangeTextInRange:(NSRange)range replacementText:(NSString *)text {
    if (NSEqualRanges(range, self.approvedRange) && [text isEqual:self.approvedText]) return YES;
    return ![self.original respondsToSelector:_cmd] || [self.original textView:view shouldChangeTextInRange:range replacementText:text];
}
@end
static void processCommand(void) {
    struct stat lease;
    if (stat([[inputDirectory stringByAppendingPathComponent:@"active"] fileSystemRepresentation], &lease) != 0 || time(NULL) - lease.st_mtime > 10 || applying) return;
    NSDictionary *command = readJSON(@"command.json");
    NSString *request = command[@"requestId"];
    if (![request isKindOfClass:NSString.class] || request.length != 36 || ![command[@"sessionId"] isEqual:inputSession] || [handled containsObject:request]) return;
    // Mark before mutation, so a repeated file can never apply the same request twice.
    if (handled.count >= 10000) { respond(request, @{@"success": @NO, @"code": @"TEXT_SESSION_LIMIT", @"error": @"Input session request limit reached; explicitly relaunch the app."}); return; }
    [handled addObject:request];
    NSString *text = command[@"text"], *mode = command[@"mode"];
    NSDictionary *cancel = readJSON(@"cancel.json");
    if (![text isKindOfClass:NSString.class] || [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 128 * 1024 || ![@[@"insert", @"replace"] containsObject:mode] || ![command[@"expiresAt"] isKindOfClass:NSNumber.class]) {
        respond(request, @{@"success": @NO, @"code": @"INVALID_TEXT_REQUEST", @"error": @"Invalid input request; no input sent."}); return;
    }
    if ([command[@"expiresAt"] doubleValue] < NSDate.date.timeIntervalSince1970 * 1000 || ([cancel[@"sessionId"] isEqual:inputSession] && [cancel[@"requestId"] isEqual:request])) {
        respond(request, @{@"success": @NO, @"code": @"TEXT_REQUEST_EXPIRED", @"error": @"Input request expired or was cancelled before application."}); return;
    }
    UIView *responder = focusedField();
    UIView *view = standardEditor(responder);
    if (!view || !supported(view)) {
        NSMutableArray *classes = [NSMutableArray array];
        for (UIView *ancestor = responder; ancestor && classes.count < 8; ancestor = ancestor.superview) [classes addObject:NSStringFromClass(ancestor.class)];
        respond(request, @{@"success": @NO, @"code": view ? @"UNSUPPORTED_TEXT_FIELD" : @"NO_FOCUSED_TEXT_FIELD",
            @"error": view ? @"Focused responder has no supported UIKit text editor. UISearchBar searchTextField, UITextField and UITextView are supported; Web/custom editors may not be. Capture the screen and focus the actual editable area. No input sent." : @"No first responder found in the enhanced app. Focus the editable area in that app, then retry. A visible keyboard alone does not confirm app focus. No input sent.",
            @"details": @{@"target": view ? target(view) : (id)NSNull.null, @"responderClass": responder ? NSStringFromClass(responder.class) : (id)NSNull.null, @"ancestorClasses": classes, @"supportsUITextInput": @([responder conformsToProtocol:@protocol(UITextInput)]), @"supportedEditors": @[@"UISearchBar.searchTextField", @"UITextField", @"UITextView"]}}); return;
    }
    id<UITextInput> field = (id<UITextInput>)view;
    if (field.markedTextRange) { respond(request, @{@"success": @NO, @"code": @"TEXT_COMPOSITION_ACTIVE", @"error": @"An IME composition is active. Commit or cancel it before Agent input; no input sent."}); return; }
    NSString *before = fieldText(view);
    UITextRange *range = [mode isEqual:@"replace"] ? [field textRangeFromPosition:field.beginningOfDocument toPosition:field.endOfDocument] : field.selectedTextRange;
    if (!range) { respond(request, @{@"success": @NO, @"code": @"TEXT_SELECTION_UNAVAILABLE", @"error": @"Text selection unavailable; no input sent."}); return; }
    NSInteger start = [field offsetFromPosition:field.beginningOfDocument toPosition:range.start], length = [field offsetFromPosition:range.start toPosition:range.end];
    if (start < 0 || length < 0 || start + length > before.length) { respond(request, @{@"success": @NO, @"code": @"INVALID_TEXT_SELECTION", @"error": @"Invalid selection; no input sent."}); return; }
    NSString *expected = [before stringByReplacingCharactersInRange:NSMakeRange(start, length) withString:text];
    applying = YES; inputRequest = request;
    @try {
        BOOL single = [view isKindOfClass:UITextField.class];
        id original = single ? (id)((UITextField *)view).delegate : (id)((UITextView *)view).delegate;
        NSRange editRange = NSMakeRange(start, length);
        BOOL accepted = YES;
        if (text.length || length) {
            if (single && [original respondsToSelector:@selector(textField:shouldChangeCharactersInRange:replacementString:)])
                accepted = [original textField:(UITextField *)view shouldChangeCharactersInRange:editRange replacementString:text];
            else if (!single && [original respondsToSelector:@selector(textView:shouldChangeTextInRange:replacementText:)])
                accepted = [original textView:(UITextView *)view shouldChangeTextInRange:editRange replacementText:text];
        }
        UITextRange *selection = field.selectedTextRange;
        BOOL selectionChanged = [mode isEqual:@"insert"] && (!selection ||
            [field offsetFromPosition:field.beginningOfDocument toPosition:selection.start] != start ||
            [field offsetFromPosition:selection.start toPosition:selection.end] != length);
        if (!accepted || ![before isEqual:fieldText(view)] || !editorFocused(view) || selectionChanged) {
            respond(request, @{@"success": @NO, @"code": @"TEXT_INPUT_REJECTED_OR_TRANSFORMED", @"error": @"App validation rejected the edit or changed the field/focus. Inspect actual state before retrying.", @"details": snapshot(view)});
            inputRequest = nil; applying = NO; return;
        }
        ISimBotValidationDelegate *proxy = [ISimBotValidationDelegate new];
        proxy.original = original; proxy.approvedRange = editRange; proxy.approvedText = text;
        @try {
            if (single) ((UITextField *)view).delegate = proxy; else ((UITextView *)view).delegate = proxy;
            if ([mode isEqual:@"replace"]) field.selectedTextRange = range;
            if (text.length) [(id<UIKeyInput>)view insertText:text];
            else if (length) [(id<UIKeyInput>)view deleteBackward];
        } @finally {
            // Do not overwrite a delegate deliberately changed by the app during an edit.
            if (single && ((UITextField *)view).delegate == proxy) ((UITextField *)view).delegate = original;
            if (!single && ((UITextView *)view).delegate == proxy) ((UITextView *)view).delegate = original;
        }
    } @catch (NSException *exception) {
        inputRequest = nil; applying = NO;
        respond(request, @{@"success": @NO, @"code": @"TEXT_INPUT_EXCEPTION", @"error": @"App raised an exception during input. Inspect field before retrying."}); return;
    }
    inputRequest = nil;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        NSDictionary *details = snapshot(view);
        BOOL accepted = [fieldText(view) isEqual:expected];
        NSMutableDictionary *result = [@{@"success": (accepted ? @YES : @NO), @"changed": (![before isEqual:fieldText(view)] ? @YES : @NO), @"details": details} mutableCopy];
        if (!accepted) { result[@"code"] = @"TEXT_INPUT_REJECTED_OR_TRANSFORMED"; result[@"error"] = @"App rejected or transformed the requested text. Actual field state is in details; inspect before retrying."; }
        respond(request, result); inputRequest = nil; applying = NO;
    });
}
void ISimBotStartTextInput(void) {
    NSString *session = NSProcessInfo.processInfo.environment[@"ISIMBOT_TEXT_INPUT_SESSION"];
    if (!session || ![[NSUUID alloc] initWithUUIDString:session]) return;
    inputSession = session; inputDirectory = [NSTemporaryDirectory() stringByAppendingPathComponent:[@"isimbot-input-" stringByAppendingString:session]];
    if (![NSFileManager.defaultManager fileExistsAtPath:[inputDirectory stringByAppendingPathComponent:@"active"]]) return;
    handled = [NSMutableSet set];
    NSDictionary *ready = @{@"sessionId": session, @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"", @"protocol": @1, @"pid": @(getpid())};
    [[NSJSONSerialization dataWithJSONObject:ready options:0 error:nil] writeToFile:[inputDirectory stringByAppendingPathComponent:@"ready.json"] options:NSDataWritingAtomic error:nil];
    inputTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(inputTimer, dispatch_time(DISPATCH_TIME_NOW, 0), 50 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(inputTimer, ^{ processCommand(); }); dispatch_resume(inputTimer);
}
void ISimBotStartEditingObservation(void) {
    NSArray *names = @[UITextFieldTextDidBeginEditingNotification, UITextViewTextDidBeginEditingNotification, UITextFieldTextDidChangeNotification, UITextViewTextDidChangeNotification, UITextFieldTextDidEndEditingNotification, UITextViewTextDidEndEditingNotification];
    for (NSUInteger index = 0; index < names.count; index++) {
        NSString *type = index < 2 ? @"editing_begin" : index < 4 ? @"text_change" : @"editing_end";
        [NSNotificationCenter.defaultCenter addObserverForName:names[index] object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            UIView *view = note.object;
            if (!supported(view)) return;
            NSMutableDictionary *details = [snapshot(view) mutableCopy];
            if (inputRequest) { details[@"requestId"] = inputRequest; details[@"source"] = @"agent"; }
            else details[@"source"] = @"app_or_user";
            ISimBotRecordEditing(type, details);
        }];
    }
}
