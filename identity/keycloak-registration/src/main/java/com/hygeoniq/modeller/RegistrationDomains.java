package com.hygeoniq.modeller;

import java.util.List;
import java.util.Locale;
import org.keycloak.Config;
import org.keycloak.authentication.*;
import org.keycloak.events.Errors;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.*;
import org.keycloak.models.utils.FormMessage;
import org.keycloak.provider.ProviderConfigProperty;

/** Registration-only policy: never changes admin provisioning or existing profiles. */
public final class RegistrationDomains implements FormAction, FormActionFactory {
    public static final String ID = "modeller-registration-domains";
    public static final String CONFIG = "allowed-domains";
    private static boolean domain(String value) {
        return value.length() <= 253 && value.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+");
    }
    static boolean allows(String email, String configuration) {
        if (email == null || configuration == null || configuration.isBlank() || configuration.length() > 4000 || email.length() > 254) return false;
        int at = email.indexOf('@');
        if (at < 1 || at != email.lastIndexOf('@')) return false;
        String candidate = email.substring(at + 1).toLowerCase(Locale.ROOT);
        if (!domain(candidate) || !email.equals(email.strip()) || email.chars().anyMatch(Character::isWhitespace)) return false;
        boolean allowed = false;
        for (String entry : configuration.toLowerCase(Locale.ROOT).split(",", -1)) {
            String rule = entry.strip();
            boolean wildcard = rule.startsWith("*.");
            String suffix = wildcard ? rule.substring(2) : rule;
            if (!domain(suffix)) return false; // Invalid policy fails closed, even after a match.
            allowed |= wildcard ? candidate.endsWith("." + suffix) : candidate.equals(suffix);
        }
        return allowed;
    }
    @Override public void validate(ValidationContext context) {
        var data = context.getHttpRequest().getDecodedFormParameters();
        var config = context.getAuthenticatorConfig();
        String policy = config == null || config.getConfig() == null ? null : config.getConfig().get(CONFIG);
        if (allows(data.getFirst(UserModel.EMAIL), policy)) { context.success(); return; }
        context.error(Errors.INVALID_REGISTRATION);
        context.validationError(data, List.of(new FormMessage(UserModel.EMAIL, "modellerEmailDomainNotAllowed")));
    }
    @Override public String getId() { return ID; }
    @Override public String getDisplayType() { return "Registration email domain allowlist"; }
    @Override public String getReferenceCategory() { return "registration-email-domains"; }
    @Override public String getHelpText() { return "Restricts this registration flow only. Admin-created accounts and existing profiles remain unaffected. Missing or invalid configuration denies registration."; }
    @Override public boolean isConfigurable() { return true; }
    @Override public boolean isUserSetupAllowed() { return false; }
    @Override public AuthenticationExecutionModel.Requirement[] getRequirementChoices() { return new AuthenticationExecutionModel.Requirement[]{AuthenticationExecutionModel.Requirement.REQUIRED, AuthenticationExecutionModel.Requirement.DISABLED}; }
    @Override public List<ProviderConfigProperty> getConfigProperties() {
        return List.of(new ProviderConfigProperty(CONFIG, "Allowed email domains", "Comma-separated exact domains; *.example.com allows subdomains only. Configure this execution as Required.", ProviderConfigProperty.STRING_TYPE, null));
    }
    @Override public void buildPage(FormContext context, LoginFormsProvider form) { }
    @Override public void success(FormContext context) { }
    @Override public boolean requiresUser() { return false; }
    @Override public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) { return true; }
    @Override public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) { }
    @Override public FormAction create(KeycloakSession session) { return this; }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
}
