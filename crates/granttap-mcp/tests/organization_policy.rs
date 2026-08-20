use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use blindplane_access::{
    AccessIssuer, CapabilityKind, CapabilityRule, Decision, Effect, PolicySpec, PrincipalKeypair,
    PrincipalKind, TenantPolicy,
};
use blindplane_crypto::SigningKey;
use granttap_mcp::login_receipt;
use granttap_mcp::organization_policy;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u16,
    tenant_id: &'static str,
    subject_id: &'static str,
    subject_key_id: String,
    issuer_id: &'static str,
    issuer_key_id: String,
    issuer_public_key: String,
    minimum_revision: &'static str,
    minimum_authorization_epoch: &'static str,
    login_issuer_id: &'static str,
    login_issuer_key_id: String,
    login_issuer_public_key: String,
}

#[derive(Serialize)]
struct LoginHeader {
    alg: &'static str,
    kid: String,
    typ: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginPayload {
    version: u16,
    tenant_id: &'static str,
    subject_id: &'static str,
    subject_key_id: String,
    user_id: &'static str,
    session_id: &'static str,
    authenticated_at: u64,
    expires_at: u64,
    authorization_epoch: &'static str,
    issuer_id: &'static str,
}

struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "granttap-mcp-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("managed")).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_policy(root: &Path, tamper: bool) {
    let issuer = AccessIssuer::from_seed("tenant-admin", [11; 32]).unwrap();
    let subject = PrincipalKeypair::from_secret_bytes(
        "acme",
        "device-1",
        PrincipalKind::Device,
        1,
        [7; 32],
        [9; 32],
    )
    .unwrap();
    let policy = TenantPolicy::issue(
        &issuer,
        subject.principal(),
        PolicySpec {
            revision: 1,
            previous_hash: [0; 32],
            authorization_epoch: 1,
            issued_at: 90,
            not_before: 100,
            not_after: 200,
            rules: vec![CapabilityRule::new(CapabilityKind::Mcp, "github", Effect::Allow).unwrap()],
        },
    )
    .unwrap();
    let trusted = issuer.trusted();
    let login_signer = SigningKey::from_seed(&[12; 32]);
    let login_public_key = login_signer.verifying_key();
    let login_key_id = login_receipt::issuer_key_id(&login_public_key);
    let manifest = Manifest {
        version: 2,
        tenant_id: "acme",
        subject_id: "device-1",
        subject_key_id: URL_SAFE_NO_PAD.encode(subject.principal().key_id()),
        issuer_id: "tenant-admin",
        issuer_key_id: URL_SAFE_NO_PAD.encode(trusted.key_id()),
        issuer_public_key: URL_SAFE_NO_PAD.encode(trusted.public_key()),
        minimum_revision: "1",
        minimum_authorization_epoch: "1",
        login_issuer_id: "granttap-control",
        login_issuer_key_id: URL_SAFE_NO_PAD.encode(login_key_id),
        login_issuer_public_key: URL_SAFE_NO_PAD.encode(login_public_key),
    };
    fs::write(
        root.join("managed/issuer.json"),
        blazingly_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let mut encoded = policy.encode();
    if tamper {
        let last = encoded.last_mut().unwrap();
        *last ^= 1;
    }
    fs::write(root.join("managed/organization-policy.bin"), encoded).unwrap();
    let header = URL_SAFE_NO_PAD.encode(
        blazingly_json::to_vec(&LoginHeader {
            alg: "EdDSA",
            kid: URL_SAFE_NO_PAD.encode(login_key_id),
            typ: "GTLOGIN",
        })
        .unwrap(),
    );
    let payload = URL_SAFE_NO_PAD.encode(
        blazingly_json::to_vec(&LoginPayload {
            version: 1,
            tenant_id: "acme",
            subject_id: "device-1",
            subject_key_id: URL_SAFE_NO_PAD.encode(subject.principal().key_id()),
            user_id: "user-1",
            session_id: "login-1",
            authenticated_at: 100,
            expires_at: 200,
            authorization_epoch: "1",
            issuer_id: "granttap-control",
        })
        .unwrap(),
    );
    let signature = login_signer.sign(format!("{header}.{payload}").as_bytes());
    fs::write(
        root.join("managed/login.receipt"),
        format!("{header}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature)),
    )
    .unwrap();
}

#[test]
fn public_endpoint_verifier_uses_blindplane_default_deny() {
    let root = TestRoot::new("org-policy");
    write_policy(root.path(), false);
    let policy = organization_policy::load(root.path(), 150)
        .unwrap()
        .unwrap();
    assert_eq!(policy.revision(), 1);
    assert_eq!(
        policy.decision(CapabilityKind::Mcp, "github", 150).unwrap(),
        Decision::Allow
    );
    assert_eq!(
        policy
            .decision(CapabilityKind::Mcp, "filesystem", 150)
            .unwrap(),
        Decision::Deny
    );
    assert!(root.path().join("managed/policy-state.json").is_file());
}

#[test]
fn public_endpoint_verifier_rejects_tampering() {
    let root = TestRoot::new("org-tamper");
    write_policy(root.path(), true);
    assert!(organization_policy::load(root.path(), 150).is_err());
}

#[test]
fn public_endpoint_verifier_requires_fresh_enterprise_login() {
    let root = TestRoot::new("org-login");
    write_policy(root.path(), false);
    fs::remove_file(root.path().join("managed/login.receipt")).unwrap();
    assert!(organization_policy::load(root.path(), 150).is_err());
}

#[test]
fn status_inspection_does_not_accept_or_persist_policy_state() {
    let root = TestRoot::new("org-inspect");
    write_policy(root.path(), false);
    assert!(organization_policy::inspect(root.path(), 150)
        .unwrap()
        .is_some());
    assert!(!root.path().join("managed/policy-state.json").exists());
}

#[test]
fn missing_issuer_keeps_personal_mode_unmanaged() {
    let root = TestRoot::new("org-unmanaged");
    fs::remove_dir(root.path().join("managed")).unwrap();
    assert!(organization_policy::load(root.path(), 150)
        .unwrap()
        .is_none());
}
