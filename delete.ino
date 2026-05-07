#include <SoftwareSerial.h>
#include <GT5X.h>

/* Delete an existing fingerprint ID from the GT5X database. */

/*  ESP32 GPIO 16 receives data from the sensor.
 *  ESP32 GPIO 17 sends data to the sensor.
 */
SoftwareSerial fserial(16, 17);

GT5X finger(&fserial);
GT5X_DeviceInfo ginfo;

void setup()
{
    Serial.begin(9600);
    Serial.println("DELETE test");
    fserial.begin(9600);

    if (finger.begin(&ginfo)) {
        Serial.println("Found fingerprint sensor!");
        Serial.print("Firmware Version: "); Serial.println(ginfo.fwversion);
    } else {
        Serial.println("Did not find fingerprint sensor :(");
        while (1) yield();
    }
}

void loop()
{
    while (Serial.read() != -1);  // clear buffer
    
    Serial.println("Enter the finger ID # you want to delete...");
    uint16_t fid = 0;
    while (true) {
        while (! Serial.available()) yield();
        char c = Serial.read();
        if (! isdigit(c)) break;
        fid *= 10;
        fid += c - '0';
        yield();
    }
    
    delete_finger(fid);
    Serial.println();
}

void delete_finger(uint16_t fid) {    
    uint16_t rc = finger.delete_id(fid);
    switch (rc) {
        case GT5X_OK:
            Serial.print("ID "); Serial.print(fid); 
            Serial.println(" deleted.");
            break;
        case GT5X_NACK_INVALID_POS:
            Serial.println("ID not used!");
            break;
        case GT5X_NACK_DB_IS_EMPTY:
            Serial.println("Database is empty!");
            break;
        default:
            Serial.print("Error code: 0x"); Serial.println(rc, HEX);
            break;
    }
}
