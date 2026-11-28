package com.hygeoniq.modeller;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class RegistrationDomainsTest {
    static final String POLICY = "gmail.com,ey.com,*.ey.com,hygeoniq.com,alpamax.eu";
    @Test void approvedDomainsAndBoundaryChecks() {
        for (String address : new String[]{"person@gmail.com", "person@ey.com", "person@uk.ey.com", "person@team.uk.ey.com", "person@HYGEONIQ.COM", "person@alpamax.eu"}) assertTrue(RegistrationDomains.allows(address, POLICY), address);
        for (String address : new String[]{"person@gmail.co", "person@sub.gmail.com", "person@evil-ey.com", "person@ey.com.evil.test", "person@sub.alpamax.eu", "person@sub.hygeoniq.com", "person@ey.com.", "person@@ey.com", "person@.ey.com", "person@-x.ey.com", " person@ey.com", "person@ey.com\n", "person@other.test", "@gmail.com"}) assertFalse(RegistrationDomains.allows(address, POLICY), address);
    }
    @Test void missingOrMalformedPolicyFailsClosed() {
        for (String policy : new String[]{null, "", " ", "gmail.com,", "gmail.com,*.com", "gmail.com,*", "gmail.com,https://ey.com"}) assertFalse(RegistrationDomains.allows("person@gmail.com", policy));
        assertFalse(RegistrationDomains.allows(null, POLICY));
    }
}
