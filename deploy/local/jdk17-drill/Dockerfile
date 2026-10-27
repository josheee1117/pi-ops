FROM eclipse-temurin:17-jdk-jammy
WORKDIR /app
COPY Drill.java .
RUN javac --add-modules jdk.httpserver,jdk.jfr Drill.java
CMD ["java", "-Xms32m", "-Xmx128m", "--add-modules", "jdk.httpserver,jdk.jfr", "Drill"]
