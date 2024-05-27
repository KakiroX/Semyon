#include <Servo.h>

Servo myservo;
Servo myservo1;
Servo myservo2;
Servo myservo3;
Servo myservo4;

int pos = 0;  // переменная для хранения позиции сервомотора

void setup() {
  myservo3.attach(3);
  myservo4.attach(4);
  myservo.attach(5);
  myservo1.attach(6);
  myservo2.attach(7);
}

void loop() {
  sweepServos(0, 180, 1, 15);  // Перемещение от 0 до 180 градусов с шагом 1 градус и задержкой 15 мс
  sweepServos(180, 0, -1, 15); // Перемещение от 180 до 0 градусов с шагом -1 градус и задержкой 15 мс
}

void sweepServos(int start, int end, int step, int delayTime) {
  for (pos = start; pos != end; pos += step) {
    myservo.write(pos);
    myservo1.write(pos);
    myservo3.write(pos);
    myservo4.write(pos);
    delay(delayTime);
  }
}
