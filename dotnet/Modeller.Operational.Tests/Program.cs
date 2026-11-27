using System.Security.Cryptography;
using Modeller.Core;
using Modeller.Operational;

var checks = 0;
void Check(bool valid, string reason) { if (!valid) throw new Exception(reason); checks++; }
void Reject(Action action, string code) { try { action(); } catch (ProcessingException error) when (error.Code == code) { checks++; return; } throw new Exception("Expected " + code); }
var root = Path.Combine(Path.GetTempPath(), "modeller-operational-fixture-" + Guid.NewGuid().ToString("N"));
var key = RandomNumberGenerator.GetBytes(32);
var scope = new OperationalScope(new string('a', 64), "synthetic", "synthetic-hospital", "synthetic-cdr");
var identity = new ClinicalIdentity("urn:synthetic-hospital:patient-number", "000001");
string pseudonym;
try {
    using (var registry = new IdentityRegistry(root, key)) {
        Check(registry.Policy(scope).PatientIdentityRequired && !registry.Policy(scope).PseudonymisePatientIdentifiers, "Patient gate remains mandatory before pseudonymisation is configured");
        Reject(() => registry.OutboundPatientIdentity(scope, identity, 0), "WAITING_PATIENT_IDENTITY");
        var patient = registry.RegisterVerifiedPatient(scope, identity, "synthetic-source-row-1", new string('b', 64)); pseudonym = patient.Pseudonym;
        Check(registry.RegisterVerifiedPatient(scope, identity, "synthetic-source-row-1", new string('c', 64)).Pseudonym == pseudonym, "Repeated patient events reuse the stable pseudonym");
        Check(registry.OutboundPatientIdentity(scope, identity, 0) == identity, "Disabled pseudonymisation still requires a registered patient");
        var policy = registry.ChangePolicy(scope, 0, true, "urn:synthetic-cdr:pseudonym");
        Check(registry.ChangePolicy(scope, policy.Revision, true, "urn:synthetic-cdr:pseudonym").Revision == policy.Revision, "Saving an unchanged privacy setting does not invalidate reviewed work");
        Check(policy.PatientIdentityRequired && policy.Revision == 1, "Pseudonymisation does not disable the patient prerequisite");
        Check(registry.Policy(scope with { SourceSystem = "another-interface-same-destination" }).PseudonymisePatientIdentifiers, "Destination privacy policy is consistent across source interfaces in the project");
        var outbound = registry.OutboundPatientIdentity(scope, identity, 1);
        Check(outbound.System == "urn:synthetic-cdr:pseudonym" && outbound.Value == pseudonym && outbound.Value != identity.Value, "Pseudonym-only outbound identity uses a separate namespace");
        Reject(() => registry.OutboundPatientIdentity(scope, identity, 0), "PRIVACY_POLICY_REVIEW_REQUIRED");
        Reject(() => registry.ChangePolicy(scope, 0, false, null), "PRIVACY_POLICY_REVISION_CONFLICT");
        Reject(() => registry.ChangePolicy(scope, 1, true, null), "IDENTITY_VALUE_REQUIRED");
        Reject(() => registry.RegisterVerifiedPatient(scope, identity, "different-source-patient", new string('d', 64)), "PATIENT_IDENTITY_CONFLICT");
        Check(registry.FindPatient(scope with { DestinationId = "another-destination" }, identity) is null, "Patient identities do not leak across destinations");
        Check(registry.FindPatient(scope, identity with { System = "urn:another-assigning-authority" }) is null, "Identical numbers with different authorities are not the same patient");
        Check(registry.FindPatient(scope with { ProjectId = "another-project" }, identity) is null, "Projects remain isolated");
        var colleagueScope = scope with { Owner = new string('f', 64) };
        Check(registry.FindPatient(colleagueScope, identity) is null, "Another operator cannot retrieve a private patient registration");
        var colleaguePatient = registry.RegisterVerifiedPatient(colleagueScope, identity, "independently-verified-source-anchor", new string('d', 64));
        Check(colleaguePatient.Pseudonym == pseudonym && colleaguePatient.RegistryId != patient.RegistryId, "Independently verified registrations reuse the same opaque project/domain/destination pseudonym without sharing private registry records");
        Check(registry.Policy(colleagueScope).Revision == policy.Revision, "Destination identity policy is consistent across authorised project operators");

        Check(registry.FindPatient(scope, identity with { Value = "1" }) is null, "Leading zeros are not silently normalised");
    }
    using (var reopened = new IdentityRegistry(root, key)) {
        Check(reopened.Policy(scope).PseudonymisePatientIdentifiers && reopened.FindPatient(scope, identity)!.Pseudonym == pseudonym, "Pseudonym and policy survive restart");
        var policy = reopened.ChangePolicy(scope, 1, false, null);
        Check(policy.Revision == 2 && reopened.OutboundPatientIdentity(scope, identity, 2) == identity, "A separately reviewed disabled policy preserves the source identity");
        reopened.ChangePolicy(scope, 2, true, "urn:synthetic-cdr:pseudonym");
        Check(reopened.OutboundPatientIdentity(scope, identity, 3).Value == pseudonym, "Toggling the policy does not regenerate the patient's pseudonym");
    }
    Reject(() => { using var wrongKey = new IdentityRegistry(root, RandomNumberGenerator.GetBytes(32)); }, "OPERATIONAL_STATE_INTEGRITY_FAILED");
    var queueScope = scope with { ProjectId = "dependencies" };
    var patientKey = new EntityKey("Patient", identity.System, identity.Value);
    var encounterKey = new EntityKey("Encounter", "urn:synthetic-hospital:encounter", "000010");
    var now = DateTimeOffset.UtcNow;
    PendingInput Input(string id, params EntityKey[] dependencies) => new("synthetic-hl7", "synthetic-channel", id, Data.Hash(id), new string('d', 64), new string('e', 64), 0, identity, dependencies, new System.Text.Json.Nodes.JsonObject { ["syntheticMessage"] = id }, now.AddDays(7));
    string encounterItem, observationItem, expiredLeaseItem;
    using (var registry = new IdentityRegistry(root, key)) {
        var queue = new DependencyQueue(registry);
        var encounter = queue.Enqueue(queueScope, Input("encounter-before-patient", patientKey), now); encounterItem = encounter.Id;
        var observation = queue.Enqueue(queueScope, Input("observation-before-encounter", encounterKey), now); observationItem = observation.Id;
        Check(encounter.State == "WAITING_PATIENT_IDENTITY" && observation.State == "WAITING_PATIENT_IDENTITY", "Every clinical input waits for the verified patient prerequisite");
        Check(queue.Enqueue(queueScope, Input("encounter-before-patient", patientKey), now).Id == encounterItem, "Repeated messages reuse their durable queue item");
        Check(queue.Enqueue(queueScope, Input("encounter-before-patient", patientKey) with { IntakeId = "another-reviewed-channel", MappingSha256 = new string('f', 64) }, now).Id != encounterItem, "Separate channel assignments do not accidentally consume one another's messages");
        Reject(() => queue.Enqueue(queueScope, Input("encounter-before-patient", patientKey) with { SourceSha256 = new string('f', 64) }, now), "MESSAGE_CONTROL_ID_CONFLICT");
        registry.RegisterVerifiedPatient(queueScope, identity, "synthetic-source-row-1", new string('b', 64));
        Check(queue.Inspect(queueScope, encounterItem, now).State == "WAITING_DEPENDENCIES", "A known patient ID does not claim that the target Patient exists");
        queue.PublishVerifiedEntity(queueScope, new(patientKey, "Patient/patient-1", new string('c', 64), "VERIFIED", registry.FindPatient(queueScope, identity)!.RegistryId));
        Check(queue.Inspect(queueScope, encounterItem, now).State == "READY", "Verified target Patient releases its Encounter");
        Check(queue.Inspect(queueScope, observationItem, now).State == "WAITING_DEPENDENCIES", "Observation stays waiting for its own Encounter");
        var lease = queue.Acquire(queueScope, encounterItem, now)!;
        Check(queue.Acquire(queueScope, encounterItem, now) is null, "Only one processing lease can own an input");
        Reject(() => registry.ChangePolicy(queueScope, 0, true, "urn:synthetic-cdr:pseudonym"), "PRIVACY_POLICY_ACTIVE_PROCESSING");
        Reject(() => registry.ChangePolicy(queueScope with { SourceSystem = "another-interface-same-destination" }, 0, true, "urn:synthetic-cdr:pseudonym"), "PRIVACY_POLICY_ACTIVE_PROCESSING");
        Reject(() => queue.Complete(queueScope, encounterItem, "wrong-lease", new string('c', 64), false, now), "PROCESSING_LEASE_CONFLICT");
        queue.Complete(queueScope, encounterItem, lease.LeaseId, new string('c', 64), false, now);
        queue.PublishVerifiedEntity(queueScope, new(encounterKey, "Encounter/encounter-1", new string('c', 64), "VERIFIED", registry.FindPatient(queueScope, identity)!.RegistryId));
        Check(queue.Inspect(queueScope, observationItem, now).State == "READY", "A successfully delivered Encounter releases its Observation");
        var observationLease = queue.Acquire(queueScope, observationItem, now)!;
        Check(queue.Complete(queueScope, observationItem, observationLease.LeaseId, new string('c', 64), true, now).State == "RECONCILIATION_REQUIRED", "An uncertain destination write is not blindly retried");
        var expiredLease = queue.Enqueue(queueScope, Input("crash-after-acquiring", patientKey), now); expiredLeaseItem = expiredLease.Id;
        Check(queue.Acquire(queueScope, expiredLeaseItem, now) is not null, "A ready input can be leased");
    }
    using (var registry = new IdentityRegistry(root, key)) {
        var queue = new DependencyQueue(registry);
        Check(queue.Inspect(queueScope, encounterItem, now).State == "DELIVERED", "Successful clinical delivery survives restart");
        Check(queue.Inspect(queueScope, observationItem, now).State == "RECONCILIATION_REQUIRED" && queue.Acquire(queueScope, observationItem, now) is null, "Restart does not repeat an uncertain write");
        Check(queue.Inspect(queueScope, expiredLeaseItem, now.AddMinutes(16)).State == "RECONCILIATION_REQUIRED", "A crashed leased process requires reconciliation after expiry");
        Reject(() => queue.Inspect(queueScope with { DestinationId = "another-destination" }, encounterItem, now), "PENDING_INPUT_UNAVAILABLE");
        var conflict = queue.Enqueue(queueScope, Input("conflicting-encounter", encounterKey), now);
        queue.PublishVerifiedEntity(queueScope, new(encounterKey, "Encounter/a-different-encounter", new string('f', 64), "VERIFIED", registry.FindPatient(queueScope, identity)!.RegistryId));
        Check(queue.Inspect(queueScope, conflict.Id, now).State == "IDENTITY_CONFLICT", "Multiple destination matches do not release a dependent input");
        var expiring = queue.Enqueue(queueScope, Input("expires-without-dependency", new EntityKey("Encounter", "urn:synthetic-hospital:encounter", "99999")) with { ExpiresAt = now.AddSeconds(1) }, now);
        var expired = queue.Inspect(queueScope, expiring.Id, now.AddSeconds(2));
        Check(expired.State == "EXPIRED" && expired.Input.Source["syntheticMessage"]!.GetValue<string>() == "expires-without-dependency", "Expiry retains the original private input for operator review");
    }
    var adt = "MSH|^~\\&|SYN|SYN|MOD|MOD|20261127120000+0000||ADT^A01^ADT_A01|SYN-1|P|2.5.1\rEVN|A01|20261127120000\rPID|1||000001^^^SYNTHETIC^MR||Example^Synthetic\rPV1|1|I\r";
    var parsedAdt = ClinicalMessages.Read(System.Text.Encoding.ASCII.GetBytes(adt), "hl7-v2")[0];
    Check(parsedAdt.Version == "2.5.1" && parsedAdt.ControlId == "SYN-1" && parsedAdt.ValidationStage == "MODEL_PARSED" && !parsedAdt.ProfileValidated, "V2 parsing retains declared version and distinguishes profile validation");
    var framed = System.Text.Encoding.ASCII.GetBytes("\u000b" + adt + "\u001c\r");
    Check(ClinicalMessages.Read(framed, "hl7-v2").Count == 1, "MLLP-framed payload can be parsed without dropping its message");
    Check(ClinicalMessages.Read(System.Text.Encoding.ASCII.GetBytes(adt + adt.Replace("SYN-1", "SYN-2")), "hl7-v2").Count == 2, "Concatenated file messages preserve separate control identifiers");
    Reject(() => ClinicalMessages.Read(System.Text.Encoding.ASCII.GetBytes("\u000b" + adt + "\u001c"), "hl7-v2"), "MLLP_FRAME_INVALID");
    Reject(() => ClinicalMessages.Read(System.Text.Encoding.ASCII.GetBytes(adt.Replace("2.5.1", "2.9.1")), "hl7-v2"), "HL7_VERSION_PROFILE_REQUIRED");
    var nil = ClinicalMessages.Read(System.Text.Encoding.ASCII.GetBytes(adt.Replace("000001^^^SYNTHETIC^MR", "\"\"")), "hl7-v2")[0];
    var pidWire = ((System.Text.Json.Nodes.JsonArray)nil.Document["wire"]!).OfType<System.Text.Json.Nodes.JsonObject>().Single(row => row["name"]!.GetValue<string>() == "PID");
    Check(pidWire["fields"]![1]!.GetValue<string>() == "" && pidWire["fields"]![2]!.GetValue<string>() == "\"\"", "Wire representation keeps empty fields distinct from explicit HL7 nulls");
    var cdaBytes = System.Text.Encoding.UTF8.GetBytes("<ClinicalDocument xmlns=\"urn:hl7-org:v3\"><id root=\"1.2.3\" extension=\"SYNTHETIC\"/><component><section><text>Before <content>middle</content> after</text></section></component></ClinicalDocument>");
    var cda = ClinicalMessages.Read(cdaBytes, "cda")[0];
    var nodes = (System.Text.Json.Nodes.JsonArray)cda.Document["nodes"]!;
    Check(cda.Standard == "CDA" && cda.ValidationStage == "XML_WELL_FORMED_ONLY" && !cda.ProfileValidated, "CDA parsing cannot claim schema or implementation-guide conformance");
    Check(string.Join("", nodes.OfType<System.Text.Json.Nodes.JsonObject>().Where(node => node["kind"]!.GetValue<string>() == "text").Select(node => node["value"]!.GetValue<string>())) == "Before middle after", "CDA mixed narrative retains its text and child order");
    Reject(() => ClinicalMessages.Read(cdaBytes, "hl7-v3"), "HL7_V3_DOCUMENT_TYPE_MISMATCH");
    var interaction = ClinicalMessages.Read(System.Text.Encoding.UTF8.GetBytes("<PRPA_IN201301UV02 xmlns=\"urn:hl7-org:v3\"><id root=\"1.2.3\" extension=\"SYNTHETIC\"/></PRPA_IN201301UV02>"), "hl7-v3")[0];
    Check(interaction.Type == "PRPA_IN201301UV02", "V3 interaction classification is distinct from CDA");
    using (var registry = new IdentityRegistry(root, key)) {
        var references = new DependencyQueue(registry);
        var referenceScope = scope with { ProjectId = "references" };
        Check(FhirReferences.Resolve(registry, references, referenceScope, 0, identity, new("logical", "Patient"), identity).State == "WAITING_PATIENT_IDENTITY", "Logical references do not bypass the patient prerequisite");
        registry.RegisterVerifiedPatient(referenceScope, identity, "synthetic-source-row-1", new string('b', 64));
        var logical = FhirReferences.Resolve(registry, references, referenceScope, 0, identity, new("logical", "Patient"), identity);
        Check(logical.State == "RESOLVED" && logical.Reference!["identifier"]!["system"]!.GetValue<string>() == identity.System && !logical.Reference.ContainsKey("reference"), "Logical references preserve assigning authority without inventing a resource address");
        Check(FhirReferences.Resolve(registry, references, referenceScope, 0, identity, new("resolve-literal", "Patient"), identity).State == "WAITING_DEPENDENCIES", "Resolving to a literal waits for verified destination evidence");
        registry.ChangePolicy(referenceScope, 0, true, "urn:synthetic-cdr:pseudonym");
        references.PublishVerifiedEntity(referenceScope, new(patientKey, "Patient/verified-destination-id", new string('c', 64), "VERIFIED", registry.FindPatient(referenceScope, identity)!.RegistryId));
        var resolved = FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("resolve-literal", "Patient"), identity);
        Check(resolved.Reference!["reference"]!.GetValue<string>() == "Patient/verified-destination-id" && !resolved.Reference.ContainsKey("identifier"), "Resolved literal references use the verified destination ID");
        Check(FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("literal", "Patient"), identity, "Patient/unverified-id").State == "WAITING_REFERENCE_VERIFICATION", "A syntactically valid but unverified literal is not accepted");
        Reject(() => registry.ChangePolicy(referenceScope, 1, false, null), "DESTINATION_IDENTITY_MIGRATION_REQUIRED");
        Reject(() => registry.ChangePolicy(referenceScope, 1, true, "urn:a-different-pseudonym-system"), "DESTINATION_IDENTITY_MIGRATION_REQUIRED");
        var pseudonymLogical = FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("logical", "Patient"), identity);
        Check(pseudonymLogical.Reference!["identifier"]!["system"]!.GetValue<string>() == "urn:synthetic-cdr:pseudonym" && pseudonymLogical.Reference["identifier"]!["value"]!.GetValue<string>() != identity.Value, "Logical Patient references obey the reviewed pseudonymisation policy");
        Check(FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("logical", "Encounter"), null).State == "WAITING_IDENTIFIER", "An absent required Encounter identifier remains on hold");
        var anotherPatient = registry.RegisterVerifiedPatient(referenceScope, identity with { Value = "000002" }, "synthetic-source-row-2", new string('b', 64));
        references.PublishVerifiedEntity(referenceScope, new(encounterKey, "Encounter/another-patients-encounter", new string('c', 64), "VERIFIED", anotherPatient.RegistryId));
        Check(FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("resolve-literal", "Encounter"), new(encounterKey.System, encounterKey.Value)).State == "IDENTITY_CONFLICT", "An Encounter belonging to another patient cannot be linked by a literal reference");
        Check(FhirReferences.Resolve(registry, references, referenceScope, 1, identity, new("logical", "Encounter"), new(encounterKey.System, encounterKey.Value)).State == "IDENTITY_CONFLICT", "Logical references cannot bypass a known patient mismatch");
        var queue = new DependencyQueue(registry);
        var wrongPatientDependency = queue.Enqueue(referenceScope, Input("wrong-patient-dependency", encounterKey) with { PrivacyPolicyRevision = 1 }, now);
        Check(wrongPatientDependency.State == "IDENTITY_CONFLICT", "A verified dependency for another patient never releases the queued input");
    }
    using (var registry = new IdentityRegistry(root, key)) {
        var resolutionScope = scope with { ProjectId = "manual-resolution" };
        var queue = new DependencyQueue(registry);
        var unknown = queue.Enqueue(resolutionScope, Input("patient-identifier-not-yet-known") with { PatientIdentity = null }, now);
        Check(unknown.State == "WAITING_PATIENT_IDENTITY", "An input with no patient ID is retained privately");
        Reject(() => queue.AttachVerifiedPatient(resolutionScope, unknown.Id, unknown.Revision, unknown.Input.SourceSha256, identity, "synthetic-human-reviewer", new string('b', 64), now), "WAITING_PATIENT_IDENTITY");
        registry.RegisterVerifiedPatient(resolutionScope, identity, "synthetic-source-row-1", new string('b', 64));
        var resolved = queue.AttachVerifiedPatient(resolutionScope, unknown.Id, unknown.Revision, unknown.Input.SourceSha256, identity, "synthetic-human-reviewer", new string('b', 64), now);
        Check(resolved.State == "READY" && resolved.Input.SourceSha256 == unknown.Input.SourceSha256 && Data.Canonical(resolved.Input.Source) == Data.Canonical(unknown.Input.Source), "A verified identity resolution retains the original input and its hash");
        Reject(() => queue.AttachVerifiedPatient(resolutionScope, unknown.Id, unknown.Revision, unknown.Input.SourceSha256, identity with { Value = "000002" }, "synthetic-human-reviewer", new string('b', 64), now), "PATIENT_RESOLUTION_CONFLICT");
    }
    var xsd = "<xs:schema xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" targetNamespace=\"urn:synthetic:hl7-profile\" xmlns:m=\"urn:synthetic:hl7-profile\" elementFormDefault=\"qualified\"><xs:include schemaLocation=\"types/patient.xsd\"/><xs:element name=\"message\"><xs:complexType><xs:sequence><xs:element name=\"patient\" type=\"m:patientType\"/></xs:sequence></xs:complexType></xs:element></xs:schema>";
    var types = "<xs:schema xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" targetNamespace=\"urn:synthetic:hl7-profile\"><xs:complexType name=\"patientType\"><xs:attribute name=\"id\" type=\"xs:string\" use=\"required\"/></xs:complexType></xs:schema>";
    var sourceProfile = new XmlSourceProfile("synthetic", "1.0.0", "urn:synthetic:hl7-profile", "message", "message.xsd", new() { ["message.xsd"] = xsd, ["types/patient.xsd"] = types }, new() { ["m"] = "urn:synthetic:hl7-profile" }, [new("PATIENT_ID_REQUIRED", "string-length(/m:message/m:patient/@id) > 0")]);
    var sourceValidation = new XmlSourceValidation(sourceProfile);
    var validation = sourceValidation.Validate(System.Text.Encoding.UTF8.GetBytes("<message xmlns=\"urn:synthetic:hl7-profile\"><patient id=\"SYNTHETIC\"/></message>"));
    Check(validation.Valid && !validation.ClinicalApproval && validation.ExecutedStages.Contains("PROFILE_XPATH"), "Pinned local schema and boolean profile assertions run without clinical approval");
    Check(!sourceValidation.Validate(System.Text.Encoding.UTF8.GetBytes("<message xmlns=\"urn:synthetic:hl7-profile\"><patient/></message>")).Valid, "XSD required attributes are enforced");
    Check(sourceValidation.Validate(System.Text.Encoding.UTF8.GetBytes("<message xmlns=\"urn:synthetic:hl7-profile\"><patient id=\"\"/></message>")).Findings.Any(finding => finding.Code == "PATIENT_ID_REQUIRED"), "Profile semantics distinguish a present-but-empty identifier");
    Check(!sourceValidation.Validate(System.Text.Encoding.UTF8.GetBytes("<other xmlns=\"urn:synthetic:hl7-profile\"/>")).Valid, "A well-formed document with the wrong profile root fails");
    sourceProfile.Files["message.xsd"] = "invalid mutation";
    Check(sourceValidation.Validate(System.Text.Encoding.UTF8.GetBytes("<message xmlns=\"urn:synthetic:hl7-profile\"><patient id=\"SYNTHETIC\"/></message>")).ProfileSha256 == validation.ProfileSha256, "Compiled source profile is immutable even if an adapter changes its original object");
    var heldBytes = System.Text.Encoding.UTF8.GetBytes("SYNTHETIC ORIGINAL\r\nwith exact bytes and leading zero 000001");
    var heldSha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(heldBytes));
    string heldId;
    using (var registry = new IdentityRegistry(root, key)) {
        var queue = new DependencyQueue(registry); var heldScope = scope with { ProjectId = "held-original" };
        var pending = Input("hold-original-file") with { PatientIdentity = null, SourceSha256 = heldSha };
        heldId = queue.Accept(heldScope, pending, heldBytes, now).Id;
        Check(queue.ReadOriginal(heldScope, heldSha).SequenceEqual(heldBytes), "A waiting input retains an encrypted exact original file copy");
        Reject(() => queue.Accept(heldScope, pending with { SourceSha256 = new string('f', 64) }, heldBytes, now), "SOURCE_CHANGED");
        Reject(() => queue.ReadOriginal(heldScope with { ProjectId = "another-project" }, heldSha), "HELD_SOURCE_UNAVAILABLE");
    }
    using (var registry = new IdentityRegistry(root, key)) {
        var queue = new DependencyQueue(registry); var heldScope = scope with { ProjectId = "held-original" };
        Check(queue.Inspect(heldScope, heldId, now).State == "WAITING_PATIENT_IDENTITY" && queue.ReadOriginal(heldScope, heldSha).SequenceEqual(heldBytes), "Held original and patient-waiting state survive restart together");
    }
    using (var registry = new IdentityRegistry(root, key, 1048576)) {
        var queue = new DependencyQueue(registry); var quotaScope = scope with { ProjectId = "admission-quota" };
        var firstBytes = System.Text.Encoding.ASCII.GetBytes(new string('q', 600000));
        var first = Input("quota-first") with { PatientIdentity = null, SourceSha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(firstBytes)) };
        queue.Accept(quotaScope, first, firstBytes, now);
        var secondBytes = System.Text.Encoding.ASCII.GetBytes(new string('r', 600000));
        var second = Input("quota-second") with { PatientIdentity = null, SourceSha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(secondBytes)) };
        Reject(() => queue.Accept(quotaScope, second, secondBytes, now), "OPERATIONAL_STORAGE_LIMIT");
        Reject(() => queue.ReadOriginal(quotaScope, second.SourceSha256), "HELD_SOURCE_UNAVAILABLE");
        Check(queue.ReadOriginal(quotaScope, first.SourceSha256).SequenceEqual(firstBytes), "Admission failure does not delete an earlier held original");
    }
    var v2ContractDefinition = new SourceContractDefinition(1, "hl7-v2", ["2.5.1"], ["ADT^A01^ADT_A01"],
        [new("patientId", "json-pointer", "/model/PID/0/3/0/components/0/value", Classification: "patient-identifier")],
        new("patientId", "patientId", "urn:synthetic-hospital:patient-number"), []);
    var v2Contract = new SourceContract(System.Text.Json.JsonSerializer.Serialize(v2ContractDefinition, Data.Json));
    var projection = new SourceProjection(v2Contract).Read(System.Text.Encoding.ASCII.GetBytes(adt))[0];
    Check(projection.PatientIdentity == identity && projection.PatientAnchor == "000001", "A declared HL7 source contract extracts the exact scoped patient identifier");
    Check(projection.SourceContractSha256 == v2Contract.Sha256 && !projection.AuthoritativePatientEvent, "Projection retains exact source contract identity and cannot assume an authoritative registration event");
    var nilPatientProjection = new SourceProjection(v2Contract).Read(System.Text.Encoding.ASCII.GetBytes(adt.Replace("000001^^^SYNTHETIC^MR", "\"\"")))[0];
    Check(nilPatientProjection.PatientIdentity is null, "Explicit HL7 null cannot become a patient identifier or generate a phantom patient");
    Reject(() => new SourceProjection(v2Contract).Read(System.Text.Encoding.ASCII.GetBytes(adt.Replace("ADT^A01^ADT_A01", "ADT^A08^ADT_A01"))), "SOURCE_MESSAGE_PROFILE_MISMATCH");
    var invalidContract = v2ContractDefinition with { Fields = [new("patientId", "json-pointer", "/id", Classification: "clinical")] };
    Reject(() => new SourceContract(System.Text.Json.JsonSerializer.Serialize(invalidContract, Data.Json)), "SOURCE_PATIENT_IDENTIFIER_CLASSIFICATION_REQUIRED");
    var jsonContract = v2ContractDefinition with { Format = "json", Versions = [], MessageTypes = [], Fields = [new("patientId", "json-pointer", "/mrn", Classification: "patient-identifier")] };
    var projectedJson = new SourceProjection(new SourceContract(System.Text.Json.JsonSerializer.Serialize(jsonContract, Data.Json))).Read(System.Text.Encoding.UTF8.GetBytes("[{\"mrn\":\"000001\"},{}]"));
    Check(projectedJson[0].PatientIdentity == identity && projectedJson[1].PatientIdentity is null, "Missing source patient IDs remain missing for the dependency queue");
    var ambiguous = jsonContract with { Fields = [new("patientId", "json-pointer", "/identifiers", Classification: "patient-identifier")] };
    Reject(() => new SourceProjection(new SourceContract(System.Text.Json.JsonSerializer.Serialize(ambiguous, Data.Json))).Read(System.Text.Encoding.UTF8.GetBytes("[{\"identifiers\":[\"000001\",\"000002\"]}]")), "SOURCE_FIELD_CARDINALITY_AMBIGUOUS");
    var modelRoot = Path.Combine(root, "source-contract-models");
    var modelStore = new ModelStore(modelRoot, new Dictionary<string, string> { ["active"] = new string('a', 64) }, "active");
    var modelActor = ModelActor.Service;
    modelStore.CreateProject("source-selection", new System.Text.Json.Nodes.JsonObject { ["name"] = "Synthetic source selection", ["fhirVersion"] = "R4", ["canonical"] = "https://example.invalid/source-selection", ["packageId"] = "org.example.synthetic.source", ["version"] = "1.0.0", ["publisher"] = "Synthetic fixture", ["dependencies"] = new System.Text.Json.Nodes.JsonArray() }, modelActor);
    var sourceModel = modelStore.ProvideModel("source-selection", new System.Text.Json.Nodes.JsonObject { ["id"] = "synthetic-source-contract", ["standard"] = "source-contract", ["version"] = "1.0.0", ["origin"] = "externally-provided", ["content"] = System.Text.Json.JsonSerializer.Serialize(jsonContract, Data.Json), ["provenance"] = new System.Text.Json.Nodes.JsonObject { ["source"] = "Synthetic interface contract" } }, modelActor);
    var patientModel = modelStore.ProvideModel("source-selection", new System.Text.Json.Nodes.JsonObject { ["id"] = "synthetic-patient-profile", ["standard"] = "FHIR", ["version"] = "1.0.0", ["origin"] = "externally-provided", ["content"] = "{\"resourceType\":\"StructureDefinition\",\"url\":\"https://example.invalid/patient\",\"version\":\"1.0.0\",\"type\":\"Patient\",\"fhirVersion\":\"4.0.1\"}", ["provenance"] = new System.Text.Json.Nodes.JsonObject { ["source"] = "Synthetic shape fixture, not a qualified clinical profile" } }, modelActor);
    var sourceRecord = new System.Text.Json.Nodes.JsonObject { ["patientId"] = "000001" };
    var patientOutput = new System.Text.Json.Nodes.JsonObject { ["resourceType"] = "Patient", ["identifier"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["system"] = "urn:synthetic-hospital:patient-number", ["value"] = "000001" }) };
    var sourceRule = new System.Text.Json.Nodes.JsonObject { ["source"] = "/patientId", ["target"] = "/identifier/0/value", ["operation"] = "copy", ["description"] = "Synthetic identifier copy", ["interpretation"] = "Exercise selection binding only", ["assumptions"] = new System.Text.Json.Nodes.JsonArray(), ["missing"] = "reject", ["null"] = "reject" };
    var patientSeed = (System.Text.Json.Nodes.JsonObject)patientOutput.DeepClone(); patientSeed["identifier"]![0]!.AsObject().Remove("value");
    var sourcePlan = new System.Text.Json.Nodes.JsonObject {
        ["schemaVersion"] = 2, ["name"] = "synthetic-source-selection", ["version"] = "1.0.0", ["direction"] = "source-direct-to-fhir", ["sourceSchemaSha256"] = Sources.SchemaHash([sourceRecord]), ["sourceProfileKey"] = sourceModel["key"]!.DeepClone(),
        ["description"] = "Selection fixture only; no clinical delivery", ["reversibility"] = "lossy", ["requirements"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["id"] = "SYN-1", ["originalText"] = "Bind exact source and target definitions before human confirmation", ["basis"] = "user-instruction" }),
        ["unresolvedQuestions"] = new System.Text.Json.Nodes.JsonArray(), ["examples"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["synthetic"] = true, ["input"] = sourceRecord.DeepClone(), ["expected"] = new System.Text.Json.Nodes.JsonArray(patientOutput.DeepClone()) }),
        ["stages"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["seed"] = patientSeed, ["rules"] = new System.Text.Json.Nodes.JsonArray(sourceRule) })
    };
    var sourceSelection = new System.Text.Json.Nodes.JsonObject { ["modelKeys"] = new System.Text.Json.Nodes.JsonArray(sourceModel["key"]!.DeepClone(), patientModel["key"]!.DeepClone()), ["executionMapping"] = sourcePlan.ToJsonString() };
    var sourceDefinition = modelStore.Prepare("source-selection", sourceSelection, modelActor);
    Check(!sourceDefinition["mappingConfirmed"]!.GetValue<bool>() && ((System.Text.Json.Nodes.JsonArray)sourceDefinition["modelPins"]!).Count == 2, "The exact supplied source contract and FHIR target are both pinned without automatic approval");
    var missingSourceSelection = (System.Text.Json.Nodes.JsonObject)sourceSelection.DeepClone(); missingSourceSelection["modelKeys"] = new System.Text.Json.Nodes.JsonArray(patientModel["key"]!.DeepClone());
    Reject(() => modelStore.Prepare("source-selection", missingSourceSelection, modelActor), "EXACT_SOURCE_PROFILE_REQUIRED");
    var changedSourceSelection = (System.Text.Json.Nodes.JsonObject)sourceSelection.DeepClone(); var changedSourcePlan = (System.Text.Json.Nodes.JsonObject)sourcePlan.DeepClone(); changedSourcePlan["sourceProfileKey"] = new string('f', 64); changedSourceSelection["executionMapping"] = changedSourcePlan.ToJsonString();
    Reject(() => modelStore.Prepare("source-selection", changedSourceSelection, modelActor), "SOURCE_PROFILE_SELECTION_MISMATCH");
    Reject(() => modelStore.Decide(sourceDefinition["subject"]!.GetValue<string>(), 0, "CONFIRMED", "An agent cannot confirm its own source mapping", modelActor), "HUMAN_MAPPING_REVIEW_REQUIRED");
    var pipelineScope = scope with { ProjectId = "private-pipeline" };
    using (var registry = new IdentityRegistry(root, key)) {
        var contractDefinition = new SourceContractDefinition(1, "json", [], [], [new("patientId", "json-pointer", "/mrn", Classification: "patient-identifier"), new("anchor", "json-pointer", "/anchor", Classification: "record-identifier"), new("name", "json-pointer", "/name", Classification: "direct-identifier"), new("value", "json-pointer", "/value")], new("patientId", "anchor", identity.System, AuthoritativeRegistration: true), []);
        var exactContract = new SourceContract(System.Text.Json.JsonSerializer.Serialize(contractDefinition, Data.Json));
        var pipelinePolicy = new ClinicalPolicy(1, pipelineScope.SourceSystem, pipelineScope.DestinationId, 0, false, null, [new("patient", "Patient", "/subject", "logical", false)], []);
        var pipeline = new ClinicalPipeline(registry, pipelineScope, pipelinePolicy, exactContract);
        var bytes = System.Text.Encoding.UTF8.GetBytes("[{\"mrn\":\"000001\",\"anchor\":\"patient-row-1\",\"name\":\"Synthetic Name\",\"value\":\"5.2\"}]");
        var record = new SourceProjection(exactContract).Read(bytes)[0];
        var source = new SourceConnection("synthetic-private", root, "json", [pipelineScope.ProjectId], [pipelineScope.Owner], pipelineScope.SourceSystem);
        var held = pipeline.Admit(source, "synthetic-channel", new string('a', 64), new string('b', 64), record, "SYN-PIPE-1", bytes, now);
        Check(held.State == "WAITING_PATIENT_IDENTITY" && registry.FindPatient(pipelineScope, identity) is null, "A contract's authoritative marker cannot alone register patients from an untrusted source");
        Check(new DependencyQueue(registry).ReadOriginal(pipelineScope, record.SourceSha256).SequenceEqual(bytes), "Private pipeline admission durably retains the exact original before reporting held status");
        pipeline.Admit(source with { TrustPatientRegistration = true }, "synthetic-channel", new string('a', 64), new string('b', 64), record, "SYN-PIPE-1", bytes, now);
        var ready = pipeline.Acquire(held.Id, new string('a', 64), new string('b', 64), now)!;
        Check(ready is not null && pipeline.MappingInput(ready)["value"]!.GetValue<string>() == "5.2", "Trusted source registration releases its own waiting clinical record without AI");
        var output = pipeline.ApplyReferences(ready!, new System.Text.Json.Nodes.JsonObject { ["resourceType"] = "Observation" });
        Check(output["subject"]!["identifier"]!["value"]!.GetValue<string>() == identity.Value && output["subject"]!["reference"] is null, "Reviewed logical references render independently of destination lookup");
        Reject(() => pipeline.ApplyReferences(ready!, new System.Text.Json.Nodes.JsonObject { ["resourceType"] = "Observation", ["performer"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["reference"] = "Patient/wrong-patient" }) }), "OUTBOUND_PATIENT_REFERENCE_UNVERIFIED");
        Reject(() => pipeline.Acquire(held.Id, new string('c', 64), new string('b', 64), now), "HELD_MAPPING_CHANGED");
        new DependencyQueue(registry).Fail(pipelineScope, ready!, Data.Hash("SYNTHETIC_VALIDATION_FAILURE"), false, now);
        Check(pipeline.Inspect(held.Id, now).State == "PROCESSING_REVIEW_REQUIRED", "A failed record cannot be silently leased again without a review decision");
        var privacyScope = pipelineScope with { ProjectId = "private-privacy" };
        registry.ChangePolicy(privacyScope, 0, true, "urn:synthetic:private-pseudonym");
        var privatePolicy = pipelinePolicy with { PrivacyPolicyRevision = 1, PseudonymisePatientIdentifiers = true, PseudonymSystem = "urn:synthetic:private-pseudonym" };
        var privatePipeline = new ClinicalPipeline(registry, privacyScope, privatePolicy, exactContract);
        var admitted = privatePipeline.Admit(source with { Projects = [privacyScope.ProjectId], TrustPatientRegistration = true }, "synthetic-private-channel", new string('a', 64), new string('b', 64), record, "SYN-PRIVATE-1", bytes, now);
        var privateLease = privatePipeline.Acquire(admitted.Id, new string('a', 64), new string('b', 64), now)!;
        var filtered = privatePipeline.MappingInput(privateLease);
        Check(filtered["patientId"]!.GetValue<string>() != identity.Value && !filtered.ContainsKey("name") && !filtered.ContainsKey("anchor") && filtered["value"]!.GetValue<string>() == "5.2", "Pseudonymisation replaces patient aliases and excludes direct identifiers while retaining clinical values");
        var protectedOutput = privatePipeline.ApplyReferences(privateLease, new System.Text.Json.Nodes.JsonObject { ["resourceType"] = "Observation", ["valueString"] = "5.2" });
        Check(protectedOutput["subject"]!["identifier"]!["system"]!.GetValue<string>() == "urn:synthetic:private-pseudonym", "Outbound Patient references use only the configured pseudonym namespace");
        Reject(() => privatePipeline.CheckPrivacy(privateLease, new System.Text.Json.Nodes.JsonObject { ["text"] = "Patient 000001" }), "OUTBOUND_DIRECT_IDENTIFIER_REJECTED");
        Reject(() => new ClinicalPipeline(registry, privacyScope, pipelinePolicy, exactContract), "PRIVACY_POLICY_REVIEW_REQUIRED");
        var targetPatient = new System.Text.Json.Nodes.JsonObject { ["resourceType"] = "Patient", ["id"] = "synthetic-patient" };
        Check(DestinationEvidence.PatientBinding(new System.Text.Json.Nodes.JsonObject { ["subject"] = new System.Text.Json.Nodes.JsonObject { ["reference"] = "Patient/synthetic-patient" } }, targetPatient, identity), "Exact direct Patient relationship can establish dependency binding");
        Check(!DestinationEvidence.PatientBinding(new System.Text.Json.Nodes.JsonObject { ["subject"] = new System.Text.Json.Nodes.JsonObject { ["reference"] = "Patient/another-patient" } }, targetPatient, identity), "A different patient's Encounter cannot establish a clinical dependency");
    }
    Check(parsedAdt.CanonicalV2Xml is { Length: > 0 }, "ER7 messages have a canonical v2 XML projection for supplied profile validation");
    var xmlAdt = ClinicalMessages.Read(parsedAdt.CanonicalV2Xml!, "hl7-v2-xml")[0];
    Check(xmlAdt.Type == parsedAdt.Type && xmlAdt.ControlId == parsedAdt.ControlId, "ER7 and v2 XML agree on declared message scope and control identity");
    var metadata = ClinicalMessages.Describe(System.Text.Encoding.ASCII.GetBytes(adt), "hl7-v2").ToJsonString();
    Check(!metadata.Contains("000001", StringComparison.Ordinal) && !metadata.Contains("Example", StringComparison.Ordinal) && metadata.Contains("NOT_INCLUDED", StringComparison.Ordinal), "HL7 inspection excludes patient values");
    var deferredScope = scope with { ProjectId = "deferred-patient-id" };
    using (var registry = new IdentityRegistry(root, key)) {
        var contractDefinition = new SourceContractDefinition(1, "json", [], [],
            [new("patientId", "json-pointer", "/patientId", Classification: "patient-identifier"), new("anchor", "json-pointer", "/temporaryPatientKey", Classification: "record-identifier")],
            new("patientId", "anchor", identity.System, AuthoritativeRegistration: true), []);
        var contract = new SourceContract(System.Text.Json.JsonSerializer.Serialize(contractDefinition, Data.Json));
        var policy = new ClinicalPolicy(1, deferredScope.SourceSystem, deferredScope.DestinationId, 0, false, null, [new("patient", "Patient", "/subject", "logical", false)], []);
        var pipeline = new ClinicalPipeline(registry, deferredScope, policy, contract);
        var source = new SourceConnection("synthetic-deferred", root, "json", [deferredScope.ProjectId], [deferredScope.Owner], deferredScope.SourceSystem, true);
        var firstBytes = System.Text.Encoding.UTF8.GetBytes("[{\"temporaryPatientKey\":\"temp-patient-key-1\"}]");
        var firstRecord = new SourceProjection(contract).Read(firstBytes)[0];
        var held = pipeline.Admit(source, "synthetic-deferred-channel", new string('a',64), new string('b',64), firstRecord, "before-id", firstBytes, now);
        Check(held.State == "WAITING_PATIENT_IDENTITY", "A stable source anchor does not invent a missing patient identifier");
        var registrationBytes = System.Text.Encoding.UTF8.GetBytes("[{\"temporaryPatientKey\":\"temp-patient-key-1\",\"patientId\":\"000001\"}]");
        var registration = new SourceProjection(contract).Read(registrationBytes)[0];
        pipeline.Admit(source, "synthetic-deferred-channel", new string('a',64), new string('b',64), registration, "verified-registration", registrationBytes, now);
        var released = pipeline.Inspect(held.Id, now);
        Check(released.State == "READY" && released.Input.PatientIdentity == identity, "A later trusted registration releases an exact stable-anchor match without AI or demographic guessing");
        Check(released.Input.Source["record"]!["patientId"] is null && new DependencyQueue(registry).ReadOriginal(deferredScope, firstRecord.SourceSha256).SequenceEqual(firstBytes), "Automatic ID resolution preserves the original normalised record and original bytes");
        var lease = pipeline.Acquire(held.Id, new string('a',64), new string('b',64), now)!;
        Check(pipeline.MappingInput(lease)["patientId"]!.GetValue<string>() == identity.Value && lease.Input.IdentityResolutionEvidenceSha256 is not null, "The resolved identifier is overlaid only in processing input with registration evidence");
        var changedBytes = System.Text.Encoding.UTF8.GetBytes("[{\"temporaryPatientKey\":\"temp-patient-key-1\",\"patientId\":\"CHANGED-ID\"}]");
        var changed = new SourceProjection(contract).Read(changedBytes)[0];
        var conflict = pipeline.Admit(source, "synthetic-deferred-channel", new string('a',64), new string('b',64), changed, "changed-identifier", changedBytes, now);
        Check(conflict.State == "IDENTITY_CONFLICT" && registry.FindPatient(deferredScope, new(identity.System,"CHANGED-ID")) is null, "Changing the identifier on a known patient anchor requires review instead of a second pseudonym");
        Check(new DependencyQueue(registry).ReadOriginal(deferredScope, changed.SourceSha256).SequenceEqual(changedBytes), "Conflicting registration input is durable before the conflict is reported");
        var boundedScope = deferredScope with { ProjectId = "bounded-active-queue" };
        var bounded = new DependencyQueue(registry, 1);
        PendingInput Small(string id, string intake) => new("synthetic-source", intake, id, Data.Hash(id), new string('a',64), new string('b',64), 0, null, [], new System.Text.Json.Nodes.JsonObject { ["synthetic"] = id }, now.AddDays(1));
        var one = bounded.Enqueue(boundedScope, Small("one", "child-flow"), now);
        Reject(() => bounded.Enqueue(boundedScope, Small("two", "child-flow"), now), "DEPENDENCY_QUEUE_CAPACITY");
        Check(bounded.Enqueue(boundedScope, Small("parent", "parent-flow"), now).State == "WAITING_PATIENT_IDENTITY", "A full child intake does not consume another intake's dependency admission capacity");
        bounded.Cancel(boundedScope, one.Id, one.Revision);
        Check(bounded.Enqueue(boundedScope, Small("two", "child-flow"), now).State == "WAITING_PATIENT_IDENTITY", "Final records do not permanently exhaust active queue capacity");
    }
    using (var registry = new IdentityRegistry(root, key)) {
        var relationScope = scope with { ProjectId = "reviewed-relationship" };
        var queue = new DependencyQueue(registry);
        var patient = registry.RegisterVerifiedPatient(relationScope, identity, "relation-patient", Data.Hash("registration"));
        var otherIdentity = new ClinicalIdentity(identity.System, "000002");
        var other = registry.RegisterVerifiedPatient(relationScope, otherIdentity, "other-relation-patient", Data.Hash("other-registration"));
        var correct = new EntityKey("Encounter", "urn:synthetic:encounter", "correct");
        var wrong = new EntityKey("Encounter", "urn:synthetic:encounter", "wrong");
        queue.PublishVerifiedEntity(relationScope, new(correct, "Encounter/correct", Data.Hash("correct-proof"), "VERIFIED", patient.RegistryId));
        queue.PublishVerifiedEntity(relationScope, new(wrong, "Encounter/wrong", Data.Hash("wrong-proof"), "VERIFIED", other.RegistryId));
        var bytes = System.Text.Encoding.UTF8.GetBytes("synthetic-missing-encounter-original");
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var source = new System.Text.Json.Nodes.JsonObject {
            ["record"] = new System.Text.Json.Nodes.JsonObject { ["patientId"] = identity.Value },
            ["relations"] = new System.Text.Json.Nodes.JsonObject { ["encounter"] = null },
            ["missingRelationships"] = new System.Text.Json.Nodes.JsonArray("encounter")
        };
        var input = new PendingInput("source", "intake", "message", sha, Data.Hash("mapping-subject"), Data.Hash("mapping-rules"), 0, identity, [], source, now.AddDays(1));
        var held = queue.Accept(relationScope, input, bytes, now);
        Check(held.State == "WAITING_RELATIONSHIP_IDENTIFIER", "Missing Encounter identifiers remain held even with a verified Patient");
        Reject(() => queue.AttachVerifiedRelationship(relationScope, held.Id, held.Revision, sha, "encounter", wrong, "reviewer", "Synthetic relationship review", now), "ENTITY_PATIENT_BINDING_REQUIRED");
        Reject(() => queue.AttachVerifiedRelationship(relationScope, held.Id, held.Revision + 1, sha, "encounter", correct, "reviewer", "Synthetic relationship review", now), "RELATIONSHIP_RESOLUTION_CONFLICT");
        var resolved = queue.AttachVerifiedRelationship(relationScope, held.Id, held.Revision, sha, "encounter", correct, "reviewer", "Verified same-patient encounter", now);
        Check(resolved.State == "READY" && resolved.Input.ResolvedRelations!["encounter"].Value == correct.Value, "An exact human-reviewed same-patient Encounter releases the held input");
        Check(resolved.Input.Source["relations"]!["encounter"] is null && queue.ReadOriginal(relationScope, sha).SequenceEqual(bytes), "Relationship resolution preserves the received source and records a separate processing overlay");
        Reject(() => queue.AttachVerifiedRelationship(relationScope, held.Id, resolved.Revision, sha, "encounter", correct, "reviewer", "Do not resolve twice", now), "RELATIONSHIP_REASSIGNMENT_REQUIRES_REVIEW");
    }
    var ehrContract = new SourceContract(System.Text.Json.JsonSerializer.Serialize(new SourceContractDefinition(1, "openehr-json", [], [],
        [new("patientId", "json-pointer", "/patient/id", Classification: "patient-identifier"), new("anchor", "json-pointer", "/patient/key", Classification: "record-identifier"), new("label", "json-pointer", "/composition/name/value")],
        new("patientId", "anchor", identity.System), []), Data.Json));
    var ehrEnvelope = System.Text.Encoding.UTF8.GetBytes("[{\"patient\":{\"id\":\"000001\",\"key\":\"ehr-patient-key\"},\"composition\":{\"_type\":\"COMPOSITION\",\"name\":{\"value\":\"Synthetic composition\"}}}]");
    var ehrRecord = new SourceProjection(ehrContract).Read(ehrEnvelope)[0];
    Check(ehrRecord.PatientIdentity == identity && ehrRecord.Record["label"]!.GetValue<string>() == "Synthetic composition", "An openEHR source can supply explicit Patient context beside the composition");
    Check(ehrRecord.InputResources![0]!["_type"]!.GetValue<string>() == "COMPOSITION" && ehrRecord.InputResources[0]!["patient"] is null, "Native validation receives only the composition, never an invented RM patient property");
    Check(ClinicalPipeline.SourceFingerprint(new("source-é+\"", "/synthetic/医院+\"", "json", ["lab"], ["owner"], "hospital-é", false)) == "d206ae7fab0a75d3235ea629932f621d4128c634ccb712e303ef3da2f3714a41", "Source trust fingerprints use identical UTF-8 framing across runtime languages");
    checks += await RecoveryTests.Run(root, key);
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { operationalChecks = checks, status = "PASS", clinicalData = "SYNTHETIC_ONLY", qualification = "DOMAIN_ONLY_NOT_RUNTIME_ENABLED" }));
} finally { CryptographicOperations.ZeroMemory(key); if (Directory.Exists(root)) Directory.Delete(root, true); }
