import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.List;
import org.hl7.fhir.r5.elementmodel.Manager.FhirFormat;
import org.hl7.fhir.r5.formats.IParser.OutputStyle;
import org.hl7.fhir.r5.formats.JsonParser;
import org.hl7.fhir.r5.model.OperationOutcome;
import org.hl7.fhir.r5.model.Coding;
import org.hl7.fhir.r5.utils.validation.constants.ReferenceValidationPolicy;
import org.hl7.fhir.utilities.FhirPublication;
import org.hl7.fhir.utilities.http.ManagedWebAccess;
import org.hl7.fhir.utilities.http.ManagedWebAccess.WebAccessPolicy;
import org.hl7.fhir.validation.ValidationEngine;
import org.hl7.fhir.validation.instance.advisor.BasePolicyAdvisorForFullValidation;

/** Exact-package entrypoint into the unmodified, checksum-pinned HL7 validator. */
public final class ValidationRunner {
    public static void main(String[] args) throws Exception {
        if (args.length < 7) throw new IllegalArgumentException("Incomplete validation job");
        String version = args[2];
        String core = switch (version) {
            case "4.0.1" -> "hl7.fhir.r4.core";
            case "4.3.0" -> "hl7.fhir.r4b.core";
            case "5.0.0" -> "hl7.fhir.r5.core";
            default -> throw new IllegalArgumentException("Unsupported FHIR release");
        };
        if (args[3].equals("-")) ManagedWebAccess.setAccessPolicy(WebAccessPolicy.PROHIBITED);
        System.out.println("HL7 FHIR Validator 6.10.4; exact-package runner; release " + version);
        // The CLI adds unversioned global packages. The library builder loads only
        // this explicit core and its required pinned xver tool support package.
        ValidationEngine engine = new ValidationEngine.ValidationEngineBuilder()
            .withVersion(version).withCanRunWithoutTerminologyServer(true)
            .fromSource(core + "#" + version);
        engine.setTerminologyServer(args[3].equals("-") ? null : args[3], null,
            FhirPublication.fromCode(version), false);
        engine.setPolicyAdvisor(new BasePolicyAdvisorForFullValidation(
            ReferenceValidationPolicy.CHECK_TYPE_IF_EXISTS, java.util.Set.of()));
        engine.setJurisdiction(args[6].equals("-")
            ? new Coding("http://unstats.un.org/unsd/methods/m49/m49.htm", "001", "World")
            : new Coding("urn:iso:std:iso:3166", args[6], null));
        for (int i = 7; i < args.length; i++) {
            String[] dependency = args[i].split("#", 2);
            engine.loadPackage(dependency[0], dependency[1]);
        }
        if (!args[5].equals("-")) engine.getIgLoader().loadIg(engine.getIgs(), engine.getBinaries(), args[5], false);
        engine.prepare();
        OperationOutcome outcome;
        try (FileInputStream input = new FileInputStream(args[0])) {
            outcome = engine.validate(FhirFormat.JSON, input, args[4].equals("-") ? List.of() : List.of(args[4]));
        }
        try (FileOutputStream output = new FileOutputStream(args[1])) {
            new JsonParser().setOutputStyle(OutputStyle.PRETTY).compose(output, outcome);
        }
        long errors = outcome.getIssue().stream().filter(issue ->
            issue.getSeverity() == OperationOutcome.IssueSeverity.ERROR ||
            issue.getSeverity() == OperationOutcome.IssueSeverity.FATAL).count();
        System.out.println("Validation completed: " + errors + " error(s), " + outcome.getIssue().size() + " issue(s).");
        System.exit(errors == 0 ? 0 : 1);
    }
}
