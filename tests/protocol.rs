use harness::protocol::{self, Framer, Outcome, Request, Snapshot};
use serde_json::Value;
use std::io::{BufReader, Cursor};

#[test]
fn shared_contract() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/protocol.json")).unwrap();
    for request in fixture["valid"].as_array().unwrap() {
        Request::parse(&serde_json::to_vec(request).unwrap()).unwrap();
    }
    for case in fixture["invalid"].as_array().unwrap() {
        let error = Request::parse(&serde_json::to_vec(&case["request"]).unwrap()).unwrap_err();
        assert_eq!(error.code, case["code"].as_i64().unwrap());
    }
    let _: Snapshot = serde_json::from_value(fixture["snapshot"].clone()).unwrap();
    for outcome in fixture["outcomes"].as_array().unwrap() {
        let _: Outcome = serde_json::from_value(outcome.clone()).unwrap();
    }
}

#[test]
fn every_boundary_preserves_unicode_and_record_order() {
    let values = [
        serde_json::json!({"text":"λ\n世界"}),
        serde_json::json!({"text":"😀a"}),
    ];
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|v| protocol::encode(v).unwrap())
        .collect();
    for width in 1..=bytes.len() {
        let mut framer = Framer::default();
        let records: Vec<_> = bytes
            .chunks(width)
            .flat_map(|part| framer.push(part).unwrap())
            .collect();
        assert!(framer.is_empty());
        let observed: Vec<Value> = records
            .iter()
            .map(|r| serde_json::from_slice(r).unwrap())
            .collect();
        assert_eq!(observed, values);
    }
}

#[test]
fn input_and_frame_limits_are_byte_limits() {
    let value = serde_json::json!({"session_id":"s","request_id":"r","text":"λ".repeat(protocol::MAX_INPUT / 2),"context":[]});
    protocol::validate("input.submit", &value).unwrap();
    let mut oversized = value;
    oversized["text"] = Value::String(format!("{}x", oversized["text"].as_str().unwrap()));
    assert_eq!(
        protocol::validate("input.submit", &oversized)
            .unwrap_err()
            .kind(),
        Some("resource_limit")
    );
    let mut reader = BufReader::new(Cursor::new(b"{\"id\":\"partial\"}"));
    assert!(protocol::read_frame(&mut reader).is_err());
    let mut framer = Framer::default();
    framer.push(&vec![b' '; protocol::MAX_RECORD]).unwrap();
    assert!(framer.push(b"\n").is_err());
}

#[test]
fn invalid_field_names_cannot_expand_error_replies() {
    for key in [
        "x".repeat(protocol::MAX_RECORD / 2),
        "\0".repeat(protocol::MAX_RECORD / 8),
    ] {
        let request = serde_json::json!({"jsonrpc":"2.0","id":"invalid","method":"session.list","params":{key:true}});
        let bytes = protocol::encode(&request).unwrap();
        assert!(bytes.len() > protocol::MAX_RECORD / 2);
        let error = Request::parse(&bytes).unwrap_err();
        assert_eq!(error.code, -32602);
        let response = protocol::response(Value::String("invalid".into()), Err(error));
        assert!(protocol::encode(&response).unwrap().len() < 1024);
    }
}
