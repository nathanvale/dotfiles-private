#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#define TOKEN_CAPACITY 16384

static const char service[] = "connectors.1password.service-account";
static const char account[] = "connectors";
static volatile sig_atomic_t interrupted = 0;

static void on_signal(int signal_number) { interrupted = signal_number; }

static bool read_private_line(int terminal, const char *prompt, char *value, size_t *length) {
  struct termios saved, private_mode;
  if (tcgetattr(terminal, &saved) != 0) return false;
  private_mode = saved;
  private_mode.c_lflag &= ~(ECHO | ICANON);
  private_mode.c_cc[VMIN] = 1;
  private_mode.c_cc[VTIME] = 0;
  if (tcsetattr(terminal, TCSAFLUSH, &private_mode) != 0) return false;
  bool valid = write(terminal, prompt, strlen(prompt)) == (ssize_t)strlen(prompt);
  size_t used = 0;
  while (valid && !interrupted) {
    unsigned char character;
    ssize_t count = read(terminal, &character, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1) { valid = false; break; }
    if (character == '\n' || character == '\r') break;
    if (character == 127 || character == 8) { if (used) value[--used] = 0; continue; }
    if (character < 32 || used == TOKEN_CAPACITY) { valid = false; break; }
    value[used++] = (char)character;
  }
  (void)write(terminal, "\n", 1);
  if (tcsetattr(terminal, TCSAFLUSH, &saved) != 0) valid = false;
  *length = used;
  return valid && !interrupted && used > 0;
}

static bool store_verified(const char *keychain_path, const char *token, size_t token_length) {
  SecKeychainRef keychain = NULL;
  SecKeychainItemRef item = NULL;
  SecTrustedApplicationRef security_tool = NULL;
  SecTrustedApplicationRef this_tool = NULL;
  SecAccessRef access = NULL;
  CFArrayRef trusted = NULL;
  void *readback = NULL;
  UInt32 readback_length = 0;
  bool success = false;
  OSStatus status = SecKeychainOpen(keychain_path, &keychain);
  if (status != errSecSuccess) goto done;
  status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
      sizeof(account) - 1, account, NULL, NULL, &item);
  if (status == errSecItemNotFound) {
    status = SecTrustedApplicationCreateFromPath("/usr/bin/security", &security_tool);
    if (status != errSecSuccess) goto done;
    status = SecTrustedApplicationCreateFromPath(NULL, &this_tool);
    if (status != errSecSuccess) goto done;
    const void *applications[] = { security_tool, this_tool };
    trusted = CFArrayCreate(kCFAllocatorDefault, applications, 2, &kCFTypeArrayCallBacks);
    if (!trusted) goto done;
    status = SecAccessCreate(CFSTR("Connectors 1Password service account"), trusted, &access);
    if (status != errSecSuccess) goto done;
    SecKeychainAttribute attributes[] = {
      { kSecServiceItemAttr, sizeof(service) - 1, (void *)service },
      { kSecAccountItemAttr, sizeof(account) - 1, (void *)account },
    };
    SecKeychainAttributeList list = { 2, attributes };
    status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list,
        (UInt32)token_length, token, keychain, access, &item);
  } else if (status == errSecSuccess) {
    status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)token_length, token);
  }
  if (status != errSecSuccess) goto done;
  if (item) { CFRelease(item); item = NULL; }
  status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
      sizeof(account) - 1, account, &readback_length, &readback, NULL);
  success = status == errSecSuccess && readback_length == token_length &&
      readback != NULL && memcmp(readback, token, token_length) == 0;
done:
  if (readback) {
    (void)memset_s(readback, readback_length, 0, readback_length);
    SecKeychainItemFreeContent(NULL, readback);
  }
  if (item) CFRelease(item);
  if (access) CFRelease(access);
  if (trusted) CFRelease(trusted);
  if (this_tool) CFRelease(this_tool);
  if (security_tool) CFRelease(security_tool);
  if (keychain) CFRelease(keychain);
  return success;
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] != '/') return 2;
  int terminal = open("/dev/tty", O_RDWR | O_CLOEXEC | O_NOCTTY);
  if (terminal < 0) return 2;
  struct sigaction action = { .sa_handler = on_signal };
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  char first[TOKEN_CAPACITY + 1] = {0};
  char second[TOKEN_CAPACITY + 1] = {0};
  size_t first_length = 0, second_length = 0;
  bool entered = read_private_line(terminal, "1Password service token: ", first, &first_length) &&
      read_private_line(terminal, "Re-enter service token: ", second, &second_length);
  bool matched = entered && first_length == second_length &&
      memcmp(first, second, first_length) == 0;
  (void)memset_s(second, sizeof(second), 0, sizeof(second));
  bool stored = matched && store_verified(argv[1], first, first_length);
  (void)memset_s(first, sizeof(first), 0, sizeof(first));
  const char *result = stored ? "Keychain token stored and verified.\n" :
      "Keychain token was not verified; setup is incomplete.\n";
  (void)write(terminal, result, strlen(result));
  close(terminal);
  return stored ? 0 : 1;
}
